import {
  BotId,
  DeveloperTaskId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DeveloperTask,
  type DeveloperTaskBrief,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionDeveloperTaskRepository } from "../persistence/Services/ProjectionDeveloperTasks.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as BotRegistry from "./BotRegistry.ts";
import * as DelegationSupervisor from "./DelegationSupervisor.ts";
import * as PartnerWakeScheduler from "./PartnerWakeScheduler.ts";
import * as PolicyEngine from "./policy/PolicyEngine.ts";
import { PolicyRulesStore } from "./policy/PolicyRulesStore.ts";

const PROJECT_ID = ProjectId.make("project-1");
const BOT_ID = BotId.make("bot-1");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } as const;
const NOW = "2026-08-01T00:00:00.000Z";
const BRIEF: DeveloperTaskBrief = {
  goal: "Fix the login redirect",
  context: "See src/login.ts",
  constraints: "Do not touch auth",
  acceptance: "pnpm test passes",
  scope: "small",
};

const parentThread = (id: string, worktreePath: string | null, branch: string | null) => ({
  id: ThreadId.make(id),
  projectId: PROJECT_ID,
  modelSelection: MODEL,
  worktreePath,
  branch,
  session: null,
  latestTurn: null,
});

const PARENT_A = parentThread("parent-a", "/work/a", "feature-a");
const PARENT_A2 = parentThread("parent-a2", "/work/a", "feature-a");
const PARENT_B = parentThread("parent-b", "/work/b", "feature-b");

const bot = (
  autonomy: "ask-first" | "small-changes" | "full" = "small-changes",
  overrides: {
    readonly canDelegate?: boolean | undefined;
    readonly archivedAt?: string | null | undefined;
    readonly readOnly?: boolean | undefined;
  } = {},
) =>
  ({
    id: BOT_ID,
    name: "Engineer",
    autonomy,
    readOnly: overrides.readOnly ?? false,
    developerEngine: null,
    canDelegate: overrides.canDelegate ?? true,
    archivedAt: overrides.archivedAt ?? null,
  }) as never;

interface WorkThreadFacts {
  readonly session: { readonly status: string } | null;
  readonly latestTurn: { readonly state: string } | null;
}

interface HarnessOptions {
  readonly autonomy?: "ask-first" | "small-changes" | "full";
  readonly canDelegate?: boolean;
  readonly archivedAt?: string | null;
  readonly readOnly?: boolean;
  readonly existingTasks?: ReadonlyArray<DeveloperTask>;
  readonly workThreads?: Readonly<Record<string, WorkThreadFacts>>;
  readonly liveSessions?: ReadonlyArray<string>;
  /** What the work thread looks like when the turn ends. */
  readonly detail?: unknown;
  readonly workspace?: { readonly worktreePath: string | null; readonly workspaceRoot: string };
  readonly policyRules?: ReadonlyArray<import("./policy/PolicyRulesStore.ts").PolicyRule>;
}

const makeHarness = Effect.fn("makeDelegationHarness")(function* (options: HarnessOptions = {}) {
  const policyLayer = PolicyEngine.layer.pipe(
    Layer.provide(
      Layer.mock(PolicyRulesStore)({
        listApplicable: () => Effect.succeed(options.policyRules ?? []),
      }),
    ),
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const taskTable = new Map<string, DeveloperTask>(
    (options.existingTasks ?? []).map((task) => [task.taskId, task]),
  );
  const parents = new Map(
    [PARENT_A, PARENT_A2, PARENT_B].map((thread) => [thread.id as string, thread]),
  );
  let counter = 0;

  const apply = (command: OrchestrationCommand) => {
    if (command.type === "developerTask.create") {
      taskTable.set(command.taskId, {
        taskId: command.taskId,
        parentThreadId: command.parentThreadId,
        parentTurnId: command.parentTurnId,
        workThreadId: null,
        workTurnIds: [],
        botId: command.botId,
        brief: command.brief,
        runtimeMode: command.runtimeMode,
        modelSelection: command.modelSelection,
        state: "queued",
        pendingRequest: null,
        result: null,
        failure: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        startedAt: null,
        completedAt: null,
      });
    } else if (command.type === "developerTask.state.set") {
      const task = taskTable.get(command.taskId)!;
      taskTable.set(command.taskId, {
        ...task,
        state: command.state,
        ...(command.workThreadId !== undefined ? { workThreadId: command.workThreadId } : {}),
        ...(command.pendingRequest !== undefined
          ? { pendingRequest: command.pendingRequest }
          : command.state === "waiting-on-bot"
            ? {}
            : { pendingRequest: null }),
        ...(command.result !== undefined ? { result: command.result } : {}),
        ...(command.failure !== undefined ? { failure: command.failure } : {}),
      });
    } else if (command.type === "developerTask.cancel") {
      const task = taskTable.get(command.taskId)!;
      taskTable.set(command.taskId, { ...task, state: "canceled", pendingRequest: null });
    }
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => apply(command)).pipe(
          Effect.andThen(Ref.update(commands, (list) => [...list, command])),
          Effect.as({ sequence: 1 }),
        ),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    }),
    Layer.mock(ProjectionDeveloperTaskRepository)({
      getById: ({ taskId }) => Effect.succeed(Option.fromNullishOr(taskTable.get(taskId))),
      listAll: () => Effect.succeed([...taskTable.values()]),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => {
        const parent = parents.get(threadId);
        if (parent !== undefined) return Effect.succeedSome(parent as never);
        const facts = options.workThreads?.[threadId];
        return facts === undefined
          ? Effect.succeedNone
          : Effect.succeedSome({ id: threadId, ...facts } as never);
      },
      getThreadCheckpointContext: () =>
        Effect.succeedSome({
          threadId: ThreadId.make("work"),
          projectId: PROJECT_ID,
          workspaceRoot: options.workspace?.workspaceRoot ?? "/work/a",
          worktreePath: options.workspace?.worktreePath ?? "/work/a",
          checkpoints: [],
        }),
      getThreadDetailById: () =>
        Effect.succeedSome((options.detail ?? { activities: [] }) as never),
    }),
    Layer.mock(ProviderService)({
      listSessions: () =>
        Effect.succeed((options.liveSessions ?? []).map((id) => ({ threadId: id }) as never)),
    }),
    Layer.mock(BotRegistry.BotRegistry)({
      get: () =>
        Effect.succeed(
          bot(options.autonomy, {
            ...(options.canDelegate !== undefined ? { canDelegate: options.canDelegate } : {}),
            ...(options.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
            ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
          }),
        ),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => {
          counter += 1;
          return new Uint8Array(size).fill(counter % 250);
        },
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

  const supervisor = yield* DelegationSupervisor.DelegationSupervisor.pipe(
    Effect.provide(
      DelegationSupervisor.layer.pipe(
        Layer.provide(policyLayer),
        Layer.provideMerge(PartnerWakeScheduler.layer.pipe(Layer.provide(dependencies))),
        Layer.provide(dependencies),
      ),
    ),
  );

  const sent = Effect.map(Ref.get(commands), (list) => list);
  const ofType = <T extends OrchestrationCommand["type"]>(type: T) =>
    Effect.map(sent, (list) =>
      list.filter((command): command is Extract<OrchestrationCommand, { type: T }> => {
        return command.type === type;
      }),
    );

  return { supervisor, taskTable, sent, ofType };
});

const sessionEvent = (threadId: string, status: string, lastError: string | null = null) =>
  ({
    type: "thread.session-set",
    payload: { threadId: ThreadId.make(threadId), session: { status, lastError } },
  }) as unknown as OrchestrationEvent;

const activityEvent = (threadId: string, kind: string, payload: Record<string, unknown>) =>
  ({
    type: "thread.activity-appended",
    payload: {
      threadId: ThreadId.make(threadId),
      activity: { id: "activity-1", kind, payload, tone: "approval", summary: kind, turnId: null },
    },
  }) as unknown as OrchestrationEvent;

const startTask = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  parent: typeof PARENT_A,
  brief: DeveloperTaskBrief = BRIEF,
) =>
  harness.supervisor.start({
    thread: parent as never,
    parentTurnId: TurnId.make("turn-1"),
    botId: BOT_ID,
    brief,
  });

const workThreadOf = (taskId: string) => ThreadId.make(`work-${taskId}`);

describe("resolveDeveloperRuntimeMode", () => {
  it("comes from autonomy and scope, never from text", () => {
    const resolve = DelegationSupervisor.resolveDeveloperRuntimeMode;
    assert.equal(
      resolve({ autonomy: "ask-first", scope: "small", readOnly: false }),
      "approval-required",
    );
    assert.equal(
      resolve({ autonomy: "small-changes", scope: "small", readOnly: false }),
      "auto-accept-edits",
    );
    assert.equal(
      resolve({ autonomy: "small-changes", scope: "medium", readOnly: false }),
      "auto-accept-edits",
    );
    assert.equal(
      resolve({ autonomy: "small-changes", scope: "large", readOnly: false }),
      "approval-required",
    );
    assert.equal(resolve({ autonomy: "full", scope: "large", readOnly: false }), "full-access");
    assert.equal(
      resolve({ autonomy: "full", scope: "small", readOnly: true }),
      "approval-required",
    );
  });
});

describe("requiresConfirmation", () => {
  it("is true for ask-first, read-only bots, and large changes under small-changes", () => {
    const needs = DelegationSupervisor.requiresConfirmation;
    assert.equal(needs({ autonomy: "ask-first", scope: "small", readOnly: false }), true);
    assert.equal(needs({ autonomy: "full", scope: "small", readOnly: true }), true);
    assert.equal(needs({ autonomy: "small-changes", scope: "large", readOnly: false }), true);
    assert.equal(needs({ autonomy: "small-changes", scope: "medium", readOnly: false }), false);
    assert.equal(needs({ autonomy: "full", scope: "large", readOnly: false }), false);
  });
});

describe("botMayAcceptApprovalClass / afterForApprovalRequested", () => {
  it("lets the bot accept only none and install", () => {
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("none"), true);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("install"), true);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("production"), false);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("secrets"), false);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("delete"), false);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("outside-workspace"), false);
    assert.equal(DelegationSupervisor.botMayAcceptApprovalClass("send"), false);
  });

  it("offers accept in wake text only for classes the bot may accept", () => {
    const install = DelegationSupervisor.afterForApprovalRequested("install");
    assert.include(install, "accept or decline");
    assert.equal(install.includes("Do not accept it yourself"), false);

    const production = DelegationSupervisor.afterForApprovalRequested("production");
    assert.include(production, "Decline it with answer_developer");
    assert.include(production, "ask_user");
    assert.include(production, "Do not accept it yourself");
    assert.equal(production.includes("accept or decline"), false);
  });
});

describe("DelegationSupervisor", () => {
  it.effect("rejects start when the bot cannot delegate", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ canDelegate: false });
      const error = yield* startTask(harness, PARENT_A).pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.equal(error.message, "I can't make changes myself; ask Hybrid.");
      assert.equal((yield* harness.ofType("developerTask.create")).length, 0);
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
    }),
  );

  it.effect("rejects start when the bot is archived", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ archivedAt: "2026-01-01T00:00:00.000Z" });
      const error = yield* startTask(harness, PARENT_A).pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.equal(error.message, "I can't make changes myself; that partner is archived.");
      assert.equal((yield* harness.ofType("developerTask.create")).length, 0);
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
    }),
  );

  const expectParked = (harness: Effect.Success<ReturnType<typeof makeHarness>>, taskId: string) =>
    Effect.gen(function* () {
      assert.equal(harness.taskTable.get(taskId)?.state, "awaiting-confirmation");
      assert.equal(harness.taskTable.get(taskId)?.workThreadId, null);
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
      assert.equal((yield* harness.ofType("thread.turn.start")).length, 0);
    });

  it.effect("ask-first start waits for confirmation and creates no work thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const result = yield* startTask(harness, PARENT_A);
      assert.equal(result.status, "needs_confirmation");
      yield* expectParked(harness, result.taskId);
    }),
  );

  it.effect("a parked task leaves a plan activity that confirm and decline retire", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const kinds = Effect.map(harness.ofType("thread.activity.append"), (commands) =>
        commands.map((command) => command.activity.kind),
      );
      const first = yield* startTask(harness, PARENT_A);
      assert.deepEqual(yield* kinds, ["developer-task.plan"]);
      const plan = (yield* harness.ofType("thread.activity.append"))[0]!;
      assert.equal(plan.threadId, PARENT_A.id);
      assert.deepEqual(plan.activity.payload, {
        taskId: first.taskId,
        goal: BRIEF.goal,
        context: BRIEF.context,
        scope: "small",
      });

      yield* harness.supervisor.confirm(first.taskId);
      const second = yield* startTask(harness, PARENT_B);
      yield* harness.supervisor.decline(second.taskId);
      assert.deepEqual(yield* kinds, [
        "developer-task.plan",
        "developer-task.plan.resolved",
        "developer-task.plan",
        "developer-task.plan.resolved",
      ]);
    }),
  );

  it.effect("a read-only bot waits for confirmation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "full", readOnly: true });
      const result = yield* startTask(harness, PARENT_A);
      assert.equal(result.status, "needs_confirmation");
      yield* expectParked(harness, result.taskId);
    }),
  );

  it.effect("a large scope under small-changes waits; a medium one does not", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "small-changes" });
      const large = yield* startTask(harness, PARENT_A, { ...BRIEF, scope: "large" });
      assert.equal(large.status, "needs_confirmation");
      yield* expectParked(harness, large.taskId);
      const medium = yield* startTask(harness, PARENT_B, { ...BRIEF, scope: "medium" });
      assert.equal(medium.status, "started");
    }),
  );

  it.effect("a parked task does not hold the worktree lock", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      yield* startTask(harness, PARENT_A);
      const second = yield* startTask(harness, PARENT_A2);
      assert.equal(second.status, "needs_confirmation");
    }),
  );

  it.effect("confirm launches the developer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "running");
      assert.equal(task.workThreadId, workThreadOf(taskId));
      assert.equal((yield* harness.ofType("thread.create")).length, 1);
      assert.equal((yield* harness.ofType("thread.turn.start")).length, 1);
    }),
  );

  it.effect("confirm queues behind the worktree writer, then promotes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "small-changes" });
      const holder = yield* startTask(harness, PARENT_A);
      assert.equal(holder.status, "started");
      const parked = yield* startTask(harness, PARENT_A2, { ...BRIEF, scope: "large" });
      assert.equal(parked.status, "needs_confirmation");

      yield* harness.supervisor.confirm(parked.taskId);
      assert.equal(harness.taskTable.get(parked.taskId)?.state, "queued");
      assert.equal((yield* harness.ofType("thread.create")).length, 1);

      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(holder.taskId), "running"));
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(holder.taskId), "ready"));
      assert.equal(harness.taskTable.get(parked.taskId)?.state, "running");
      assert.equal((yield* harness.ofType("thread.create")).length, 2);
    }),
  );

  it.effect("double confirm is a no-op", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      yield* harness.supervisor.confirm(taskId);
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
      assert.equal((yield* harness.ofType("thread.create")).length, 1);
      assert.equal((yield* harness.ofType("thread.turn.start")).length, 1);
    }),
  );

  it.effect("concurrent confirms launch once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* Effect.all([harness.supervisor.confirm(taskId), harness.supervisor.confirm(taskId)], {
        concurrency: "unbounded",
      });
      assert.equal((yield* harness.ofType("thread.create")).length, 1);
    }),
  );

  it.effect("confirm on a task that is already running is a no-op", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      assert.equal((yield* harness.ofType("thread.create")).length, 1);
    }),
  );

  it.effect("decline cancels without a work thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.decline(taskId);
      assert.equal(harness.taskTable.get(taskId)?.state, "canceled");
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
      // Declining again is harmless; confirming a declined task is refused.
      yield* harness.supervisor.decline(taskId);
      const error = yield* harness.supervisor.confirm(taskId).pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
    }),
  );

  it.effect("edit cancels without a work thread and wakes the partner to revise", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.edit(taskId);
      assert.equal(harness.taskTable.get(taskId)?.state, "canceled");
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
      assert.equal((yield* harness.ofType("developerTask.create")).length, 1);

      const resolved = (yield* harness.ofType("thread.activity.append")).filter(
        (command) => command.activity.kind === "developer-task.plan.resolved",
      );
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.threadId, PARENT_A.id);
      assert.deepEqual(resolved[0]!.activity.payload, { taskId, decision: "edit" });

      const wakes = (yield* harness.ofType("thread.turn.start")).filter(
        (turn) => turn.message.origin === "system-wake",
      );
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.threadId, PARENT_A.id);
      assert.include(wakes[0]!.message.text, 'kind="plan.edit"');
      assert.include(wakes[0]!.message.text, "edit");

      // Editing again is harmless and wakes nothing more; confirming or declining is refused.
      yield* harness.supervisor.edit(taskId);
      const confirmError = yield* harness.supervisor.confirm(taskId).pipe(Effect.flip);
      assert.equal(confirmError._tag, "DelegationRejectedError");
      const declineError = yield* harness.supervisor.decline(taskId).pipe(Effect.flip);
      assert.equal(declineError._tag, "DelegationRejectedError");
      assert.equal((yield* harness.ofType("thread.create")).length, 0);
      assert.equal(
        (yield* harness.ofType("thread.turn.start")).filter(
          (turn) => turn.message.origin === "system-wake",
        ).length,
        1,
      );
    }),
  );

  it.effect("decline does not wake the partner", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.decline(taskId);
      assert.equal(
        (yield* harness.ofType("thread.turn.start")).filter(
          (turn) => turn.message.origin === "system-wake",
        ).length,
        0,
      );
    }),
  );

  it.effect("edit of a running task is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      const error = yield* harness.supervisor.edit(taskId).pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
    }),
  );

  it.effect("decline of a running task is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      const error = yield* harness.supervisor.decline(taskId).pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
    }),
  );

  it.effect("start creates the work thread and sends the developer brief", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { taskId, status } = yield* startTask(harness, PARENT_A);
      assert.equal(status, "started");

      const create = (yield* harness.ofType("developerTask.create"))[0]!;
      assert.equal(create.runtimeMode, "auto-accept-edits");
      assert.ok(create.commandId.startsWith("server:"));

      const thread = (yield* harness.ofType("thread.create"))[0]!;
      assert.equal(thread.threadId, workThreadOf(taskId));
      assert.equal(thread.kind, "work");
      assert.equal(thread.parentThreadId, PARENT_A.id);
      assert.equal(thread.projectId, PROJECT_ID);
      assert.equal(thread.worktreePath, "/work/a");
      assert.equal(thread.branch, "feature-a");
      assert.ok(thread.commandId.startsWith("server:"));

      const running = (yield* harness.ofType("developerTask.state.set"))[0]!;
      assert.equal(running.state, "running");
      assert.equal(running.workThreadId, workThreadOf(taskId));

      const turn = (yield* harness.ofType("thread.turn.start"))[0]!;
      assert.equal(turn.threadId, workThreadOf(taskId));
      assert.equal(turn.message.origin, "developer-brief");
      assert.equal(turn.message.visibility, "internal");
      assert.equal(turn.message.developerTaskId, taskId);
      assert.equal(turn.runtimeMode, "auto-accept-edits");
      assert.include(turn.message.text, "Goal: Fix the login redirect");
      assert.include(turn.message.text, "Done when: pnpm test passes");
      assert.include(turn.message.text, "Constraints: Do not touch auth");
      assert.ok(turn.commandId.startsWith("server:"));
    }),
  );

  it.effect("maps bot autonomy to the runtime mode", () =>
    Effect.gen(function* () {
      const askFirst = yield* makeHarness({ autonomy: "ask-first" });
      yield* askFirst.supervisor.confirm((yield* startTask(askFirst, PARENT_A)).taskId);
      assert.equal(
        (yield* askFirst.ofType("thread.turn.start"))[0]!.runtimeMode,
        "approval-required",
      );

      const full = yield* makeHarness({ autonomy: "full" });
      yield* startTask(full, PARENT_A);
      assert.equal((yield* full.ofType("thread.turn.start"))[0]!.runtimeMode, "full-access");

      const large = yield* makeHarness();
      yield* large.supervisor.confirm(
        (yield* startTask(large, PARENT_A, { ...BRIEF, scope: "large" })).taskId,
      );
      assert.equal((yield* large.ofType("thread.turn.start"))[0]!.runtimeMode, "approval-required");
    }),
  );

  it.effect("write lock queues a second task on the same worktree and promotes it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        detail: { latestTurn: null, checkpoints: [], messages: [] },
      });
      const first = yield* startTask(harness, PARENT_A);
      // A different chat thread, but the same worktree.
      const second = yield* startTask(harness, PARENT_A2);
      // Another worktree is independent.
      const other = yield* startTask(harness, PARENT_B);

      assert.equal(first.status, "started");
      assert.equal(second.status, "queued");
      assert.equal(other.status, "started");
      assert.equal(harness.taskTable.get(second.taskId)!.state, "queued");
      assert.equal(harness.taskTable.get(second.taskId)!.workThreadId, null);

      const launched = (yield* harness.ofType("thread.create")).map((command) => command.threadId);
      assert.deepEqual(launched, [workThreadOf(first.taskId), workThreadOf(other.taskId)]);

      // The first task's turn runs, then finishes: the lock frees and the queue advances.
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(first.taskId), "running"));
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(first.taskId), "ready"));

      assert.equal(harness.taskTable.get(first.taskId)!.state, "completed");
      assert.equal(harness.taskTable.get(second.taskId)!.state, "running");
      assert.equal(harness.taskTable.get(second.taskId)!.workThreadId, workThreadOf(second.taskId));
      const workTurns = (yield* harness.ofType("thread.turn.start"))
        .filter((command) => command.message.origin !== "system-wake")
        .map((command) => command.threadId);
      assert.deepEqual(workTurns, [
        workThreadOf(first.taskId),
        workThreadOf(other.taskId),
        workThreadOf(second.taskId),
      ]);
      const wakes = (yield* harness.ofType("thread.turn.start")).filter(
        (command) => command.message.origin === "system-wake",
      );
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.threadId, PARENT_A.id);
    }),
  );

  it.effect("stopping the lock holder promotes the queued task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* startTask(harness, PARENT_A);
      const second = yield* startTask(harness, PARENT_A2);
      assert.equal(second.status, "queued");

      yield* harness.supervisor.stop(first.taskId);

      assert.equal(harness.taskTable.get(first.taskId)!.state, "canceled");
      assert.equal(
        (yield* harness.ofType("thread.turn.interrupt"))[0]!.threadId,
        workThreadOf(first.taskId),
      );
      assert.equal(harness.taskTable.get(second.taskId)!.state, "running");
    }),
  );

  it.effect("stopping a task retires its open decision cards", () =>
    Effect.gen(function* () {
      const card = (cardId: string, taskId: string) => ({
        kind: "partner-decision",
        payload: { cardId, taskId },
      });
      // The fixture reads this object at stop time, after the task id exists.
      const activities: Array<{ kind: string; payload: unknown }> = [];
      const harness = yield* makeHarness({ detail: { activities } });
      const first = yield* startTask(harness, PARENT_A);
      activities.push(
        card("card-open", first.taskId),
        card("card-other-task", "other-task"),
        card("card-answered", first.taskId),
        { kind: "partner-decision.resolved", payload: { cardId: "card-answered" } },
      );
      yield* harness.supervisor.stop(first.taskId);
      const retired = (yield* harness.ofType("thread.activity.append")).filter(
        (command) => command.activity.kind === "partner-decision.resolved",
      );
      assert.deepEqual(
        retired.map((command) => (command.activity.payload as { cardId: string }).cardId),
        ["card-open"],
      );
    }),
  );

  it.effect("a queued task that is stopped never launches", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* startTask(harness, PARENT_A);
      const second = yield* startTask(harness, PARENT_A2);
      yield* harness.supervisor.stop(second.taskId);
      yield* harness.supervisor.stop(first.taskId);

      const launched = (yield* harness.ofType("thread.create")).map((command) => command.threadId);
      assert.deepEqual(launched, [workThreadOf(first.taskId)]);
    }),
  );

  it.effect("turn completion sets the result from checkpoints and the final message", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("work-turn-1");
      const harness = yield* makeHarness({
        detail: {
          latestTurn: { turnId },
          checkpoints: [
            {
              turnId,
              status: "ready",
              checkpointTurnCount: 1,
              files: [
                { path: "src/login.ts", kind: "modified", additions: 4, deletions: 1 },
                { path: "src/login.test.ts", kind: "added", additions: 20, deletions: 0 },
              ],
            },
          ],
          messages: [
            { role: "user", streaming: false, turnId, text: "brief" },
            { role: "assistant", streaming: false, turnId, text: "  Fixed the redirect.\n" },
          ],
        },
      });
      const { taskId } = yield* startTask(harness, PARENT_A);

      // "ready" before the turn was seen running is session startup, not completion.
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "ready"));
      assert.equal(harness.taskTable.get(taskId)!.state, "running");

      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "running"));
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "ready"));

      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "completed");
      assert.equal(task.result?.summary, "Fixed the redirect.");
      assert.equal(task.result?.checkpointTurnCount, 1);
      assert.deepEqual(task.result?.filesChanged, [
        { path: "src/login.ts", additions: 4, deletions: 1 },
        { path: "src/login.test.ts", additions: 20, deletions: 0 },
      ]);
    }),
  );

  it.effect("a session error fails the task with the provider's message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "running"));
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "error", "boom"));

      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "failed");
      assert.equal(task.failure?.code, "developer-failed");
      assert.equal(task.failure?.message, "boom");
    }),
  );

  it.effect("a failed task still reports filesChanged from the checkpoint diff", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("work-turn-fail");
      const harness = yield* makeHarness({
        detail: {
          latestTurn: { turnId },
          checkpoints: [
            {
              turnId,
              status: "ready",
              checkpointTurnCount: 1,
              files: [
                {
                  path: "apps/web/src/bots/hatchBot.ts",
                  kind: "modified",
                  additions: 2,
                  deletions: 3,
                },
              ],
            },
          ],
          messages: [{ role: "assistant", streaming: false, turnId, text: "edited hatchBot" }],
        },
      });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.handleEvent(sessionEvent(workThreadOf(taskId), "running"));
      yield* harness.supervisor.handleEvent(
        sessionEvent(workThreadOf(taskId), "error", "tests failed"),
      );

      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "failed");
      assert.deepEqual(task.result?.filesChanged, [
        { path: "apps/web/src/bots/hatchBot.ts", additions: 2, deletions: 3 },
      ]);

      const wakes = (yield* harness.ofType("thread.turn.start")).filter(
        (turn) => turn.message.origin === "system-wake",
      );
      assert.equal(wakes.length, 1);
      assert.include(wakes[0]!.message.text, "apps/web/src/bots/hatchBot.ts");
      assert.include(wakes[0]!.message.text, 'kind="task.failed"');
    }),
  );

  const approvalEvent = (
    threadId: ReturnType<typeof workThreadOf>,
    requestId: string,
    requestKind: string,
    detail: string,
  ) => activityEvent(threadId, "approval.requested", { requestId, requestKind, detail });

  it.effect("auto-accepts in-worktree edits and test commands under small-changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        workspace: { worktreePath: "/work/a", workspaceRoot: "/work/a" },
      });
      const { taskId } = yield* startTask(harness, PARENT_A);
      const threadId = workThreadOf(taskId);

      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-edit", "file-change", "/work/a/src/login.ts"),
      );
      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-test", "command", "pnpm test"),
      );
      // The same request twice is answered once.
      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-test", "command", "pnpm test"),
      );

      const responses = yield* harness.ofType("thread.approval.respond");
      assert.deepEqual(
        responses.map((response) => [response.requestId, response.decision]),
        [
          ["req-edit", "accept"],
          ["req-test", "accept"],
        ],
      );
      assert.ok(responses.every((response) => response.commandId.startsWith("server:")));
      assert.equal(harness.taskTable.get(taskId)!.state, "running");
    }),
  );

  it.effect("git push parks the task waiting-on-bot and wakes the partner without answering", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { taskId } = yield* startTask(harness, PARENT_A);
      const threadId = workThreadOf(taskId);

      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-push", "command", "git push origin main"),
      );

      assert.deepEqual(yield* harness.ofType("thread.approval.respond"), []);
      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "waiting-on-bot");
      assert.equal(task.pendingRequest?.kind, "approval");
      assert.equal(task.pendingRequest?.requestId, "req-push");
      assert.equal(task.pendingRequest?.approvalClass, "production");
      assert.include(task.pendingRequest?.summary ?? "", "git push origin main");

      const wakes = (yield* harness.ofType("thread.turn.start")).filter(
        (turn) => turn.message.origin === "system-wake",
      );
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.threadId, PARENT_A.id);
      assert.include(wakes[0]!.message.text, 'kind="approval.requested"');
      assert.include(wakes[0]!.message.text, "class: production");
      assert.include(wakes[0]!.message.text, "Decline it with answer_developer");
      assert.include(wakes[0]!.message.text, "ask_user");
      assert.include(wakes[0]!.message.text, "Do not accept it yourself");
      assert.equal(wakes[0]!.message.text.includes("accept or decline"), false);
      // The developer is not told anything yet; the partner decides.
      const toDeveloper = (yield* harness.ofType("thread.turn.start")).filter(
        (turn) => turn.threadId === threadId && turn.message.origin === "bot",
      );
      assert.equal(toDeveloper.length, 0);
    }),
  );

  it.effect("rejects bot accept of production and leaves the developer blocked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      const threadId = workThreadOf(taskId);
      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-prod", "command", "git push origin main"),
      );
      assert.equal(harness.taskTable.get(taskId)?.state, "waiting-on-bot");

      const error = yield* harness.supervisor
        .answer({
          taskId,
          requestId: "req-prod",
          decision: "accept",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.match(error.message, /user's OK/i);
      assert.equal(harness.taskTable.get(taskId)?.state, "waiting-on-bot");
      assert.equal(harness.taskTable.get(taskId)?.pendingRequest?.requestId, "req-prod");
      assert.deepEqual(yield* harness.ofType("thread.approval.respond"), []);
    }),
  );

  it.effect("lets the bot decline a production approval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      yield* harness.supervisor.handleEvent(
        approvalEvent(workThreadOf(taskId), "req-prod-decline", "command", "git push origin main"),
      );

      yield* harness.supervisor.answer({
        taskId,
        requestId: "req-prod-decline",
        decision: "decline",
      });

      const responds = yield* harness.ofType("thread.approval.respond");
      assert.equal(responds.length, 1);
      assert.equal(responds[0]?.decision, "decline");
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
      assert.equal(harness.taskTable.get(taskId)?.pendingRequest, null);
    }),
  );

  it.effect("accepts production when the user granted the decision", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      yield* harness.supervisor.handleEvent(
        approvalEvent(workThreadOf(taskId), "req-prod-user", "command", "git push origin main"),
      );

      yield* harness.supervisor.answer({
        taskId,
        requestId: "req-prod-user",
        decision: "accept",
        userGranted: true,
      });

      const responds = yield* harness.ofType("thread.approval.respond");
      assert.equal(responds.length, 1);
      assert.equal(responds[0]?.decision, "accept");
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
    }),
  );

  it.effect("auto-accepts an Always-allow production push with no bot involvement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        autonomy: "ask-first",
        policyRules: [
          {
            id: "rule-push",
            scope: "bot",
            scopeId: BOT_ID,
            actionText: "git push origin main",
            decision: "allow",
            approvalClass: "production",
            matchDetail: "git push origin main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      yield* harness.supervisor.handleEvent(
        approvalEvent(workThreadOf(taskId), "req-always", "command", "git push origin main"),
      );

      assert.equal(harness.taskTable.get(taskId)?.state, "running");
      assert.equal(harness.taskTable.get(taskId)?.pendingRequest, null);
      const responds = yield* harness.ofType("thread.approval.respond");
      assert.equal(responds.length, 1);
      assert.equal(responds[0]?.decision, "accept");
      const partnerWakes = (yield* harness.ofType("thread.turn.start")).filter(
        (turn) => turn.threadId === PARENT_A.id && turn.message.origin === "system-wake",
      );
      assert.equal(partnerWakes.length, 0);
    }),
  );

  it.effect("lets the bot accept an install approval under ask-first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      yield* harness.supervisor.handleEvent(
        approvalEvent(workThreadOf(taskId), "req-install-bot", "command", "pnpm add left-pad"),
      );
      assert.equal(harness.taskTable.get(taskId)?.state, "waiting-on-bot");
      assert.equal(harness.taskTable.get(taskId)?.pendingRequest?.approvalClass, "install");

      yield* harness.supervisor.answer({
        taskId,
        requestId: "req-install-bot",
        decision: "accept",
      });

      const responds = yield* harness.ofType("thread.approval.respond");
      assert.equal(responds.length, 1);
      assert.equal(responds[0]?.decision, "accept");
      assert.equal(harness.taskTable.get(taskId)?.state, "running");
    }),
  );

  it.effect("outside-workspace requests ask instead of auto-declining", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        workspace: { worktreePath: "/work/a", workspaceRoot: "/work/a" },
      });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.handleEvent(
        approvalEvent(workThreadOf(taskId), "req-out", "file-change", "/etc/hosts"),
      );
      assert.deepEqual(yield* harness.ofType("thread.approval.respond"), []);
      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "waiting-on-bot");
      assert.equal(task.pendingRequest?.approvalClass, "outside-workspace");
    }),
  );

  it.effect("secrets under ask-first are declined with a reason and the partner is woken", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ autonomy: "ask-first" });
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.confirm(taskId);
      const threadId = workThreadOf(taskId);

      yield* harness.supervisor.handleEvent(
        approvalEvent(threadId, "req-env", "file-read", "/work/a/.env"),
      );

      const responses = yield* harness.ofType("thread.approval.respond");
      assert.deepEqual(
        responses.map((response) => [response.requestId, response.decision]),
        [["req-env", "decline"]],
      );
      const turns = yield* harness.ofType("thread.turn.start");
      const toDeveloper = turns.filter((turn) => turn.threadId === threadId);
      const wakes = turns.filter((turn) => turn.message.origin === "system-wake");
      const reason = toDeveloper.at(-1)!;
      assert.equal(reason.message.visibility, "internal");
      assert.equal(reason.message.developerTaskId, taskId);
      assert.include(reason.message.text, "declined");
      assert.include(reason.message.text, "secrets");
      assert.equal(wakes.length, 1);
      assert.include(wakes[0]!.message.text, "approval.declined");
    }),
  );

  it.effect("installs are allowed under small-changes and asked under ask-first", () =>
    Effect.gen(function* () {
      const small = yield* makeHarness();
      const smallTask = yield* startTask(small, PARENT_A);
      yield* small.supervisor.handleEvent(
        approvalEvent(
          workThreadOf(smallTask.taskId),
          "req-install",
          "command",
          "pnpm add left-pad",
        ),
      );
      assert.deepEqual(
        (yield* small.ofType("thread.approval.respond")).map((response) => response.decision),
        ["accept"],
      );

      const strict = yield* makeHarness({ autonomy: "ask-first" });
      const strictTask = yield* startTask(strict, PARENT_A);
      yield* strict.supervisor.confirm(strictTask.taskId);
      yield* strict.supervisor.handleEvent(
        approvalEvent(
          workThreadOf(strictTask.taskId),
          "req-install",
          "command",
          "pnpm add left-pad",
        ),
      );
      assert.deepEqual(yield* strict.ofType("thread.approval.respond"), []);
      assert.equal(
        strict.taskTable.get(strictTask.taskId)!.pendingRequest?.approvalClass,
        "install",
      );
    }),
  );

  it.effect("a developer question parks the task as waiting-on-bot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { taskId } = yield* startTask(harness, PARENT_A);
      yield* harness.supervisor.handleEvent(
        activityEvent(workThreadOf(taskId), "user-input.requested", {
          requestId: "req-q",
          questions: [{ id: "q1", question: "Which redirect?" }],
        }),
      );
      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "waiting-on-bot");
      assert.equal(task.pendingRequest?.requestId, "req-q");
      assert.equal(task.pendingRequest?.kind, "question");
      assert.equal(task.pendingRequest?.summary, "Which redirect?");

      yield* harness.supervisor.answer({
        taskId,
        requestId: "req-q",
        answers: { q1: "the login one" },
      });
      assert.equal(harness.taskTable.get(taskId)!.state, "running");
      assert.equal((yield* harness.ofType("thread.user-input.respond")).length, 1);
    }),
  );

  it.effect("message steers a started task and rejects one that has not started", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* startTask(harness, PARENT_A);
      const second = yield* startTask(harness, PARENT_A2);

      yield* harness.supervisor.message({
        taskId: first.taskId,
        turnId: TurnId.make("turn-2"),
        text: "Also update the docs",
      });
      assert.equal((yield* harness.ofType("developerTask.steer")).length, 1);
      const steer = (yield* harness.ofType("thread.turn.start")).at(-1)!;
      assert.equal(steer.threadId, workThreadOf(first.taskId));
      assert.equal(steer.message.text, "Also update the docs");
      assert.equal(steer.message.origin, "bot");

      const exit = yield* Effect.exit(
        harness.supervisor.message({
          taskId: second.taskId,
          turnId: TurnId.make("turn-2"),
          text: "hello?",
        }),
      );
      assert.equal(exit._tag, "Failure");
    }),
  );
});

const existingTask = (overrides: Partial<DeveloperTask>): DeveloperTask => ({
  taskId: DeveloperTaskId.make("task-existing"),
  parentThreadId: PARENT_A.id,
  parentTurnId: TurnId.make("turn-1"),
  workThreadId: workThreadOf("task-existing"),
  workTurnIds: [],
  botId: BOT_ID,
  brief: BRIEF,
  runtimeMode: "auto-accept-edits",
  modelSelection: MODEL,
  state: "running",
  pendingRequest: null,
  result: null,
  failure: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  ...overrides,
});

const rehydrate = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* harness.supervisor.startReactor().pipe(Scope.provide(scope));
    // The reactor rehydrates in a forked fiber; let it run.
    for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
    return scope;
  });

describe("DelegationSupervisor rehydration", () => {
  it.effect("fails a running task whose work session is gone", () =>
    Effect.gen(function* () {
      const task = existingTask({});
      const harness = yield* makeHarness({
        existingTasks: [task],
        workThreads: { [task.workThreadId!]: { session: null, latestTurn: null } },
      });
      yield* rehydrate(harness);

      const rehydrated = harness.taskTable.get(task.taskId)!;
      assert.equal(rehydrated.state, "failed");
      assert.equal(rehydrated.failure?.code, "interrupted");
    }),
  );

  it.effect("fails a task the projection calls running but the provider no longer has", () =>
    Effect.gen(function* () {
      const task = existingTask({});
      const harness = yield* makeHarness({
        existingTasks: [task],
        workThreads: {
          [task.workThreadId!]: {
            session: { status: "running" },
            latestTurn: { state: "running" },
          },
        },
        liveSessions: [],
      });
      yield* rehydrate(harness);
      assert.equal(harness.taskTable.get(task.taskId)!.failure?.code, "interrupted");
    }),
  );

  it.effect("keeps a task with a live session and holds its worktree lock", () =>
    Effect.gen(function* () {
      const task = existingTask({});
      const harness = yield* makeHarness({
        existingTasks: [task],
        workThreads: {
          [task.workThreadId!]: {
            session: { status: "running" },
            latestTurn: { state: "running" },
          },
        },
        liveSessions: [task.workThreadId!],
        detail: { latestTurn: null, checkpoints: [], messages: [] },
      });
      yield* rehydrate(harness);
      assert.equal(harness.taskTable.get(task.taskId)!.state, "running");

      // The rehydrated task still owns the worktree, so a new task queues behind it.
      const next = yield* startTask(harness, PARENT_A2);
      assert.equal(next.status, "queued");

      // And its completion is still noticed.
      yield* harness.supervisor.handleEvent(sessionEvent(task.workThreadId!, "ready"));
      assert.equal(harness.taskTable.get(task.taskId)!.state, "completed");
      assert.equal(harness.taskTable.get(next.taskId)!.state, "running");
    }),
  );

  it.effect("launches queued tasks that were waiting for the lock", () =>
    Effect.gen(function* () {
      const task = existingTask({ workThreadId: null, state: "queued", startedAt: null });
      const harness = yield* makeHarness({ existingTasks: [task] });
      yield* rehydrate(harness);

      assert.equal(harness.taskTable.get(task.taskId)!.state, "running");
      assert.equal((yield* harness.ofType("thread.create")).length, 1);
    }),
  );

  it.effect("ignores finished tasks", () =>
    Effect.gen(function* () {
      const task = existingTask({ state: "completed" });
      const harness = yield* makeHarness({ existingTasks: [task] });
      yield* rehydrate(harness);
      assert.equal((yield* harness.sent).length, 0);
    }),
  );
});
