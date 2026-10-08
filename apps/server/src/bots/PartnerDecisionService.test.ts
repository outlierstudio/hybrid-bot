import {
  BotId,
  type DeveloperTask,
  DeveloperTaskId,
  PartnerDecisionCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionDeveloperTaskRepository } from "../persistence/Services/ProjectionDeveloperTasks.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as BotRegistry from "./BotRegistry.ts";
import * as DelegationSupervisor from "./DelegationSupervisor.ts";
import * as PartnerDecisionService from "./PartnerDecisionService.ts";
import * as PartnerWakeScheduler from "./PartnerWakeScheduler.ts";
import * as PolicyEngine from "./policy/PolicyEngine.ts";
import { type AddPolicyRuleInput, PolicyRulesStore } from "./policy/PolicyRulesStore.ts";

const PROJECT_ID = ProjectId.make("project-1");
const BOT_ID = BotId.make("bot-1");
const PARENT_ID = ThreadId.make("parent-a");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } as const;
const PARENT = {
  id: PARENT_ID,
  projectId: PROJECT_ID,
  modelSelection: MODEL,
  worktreePath: "/work/a",
  branch: "feature-a",
  session: null,
  latestTurn: null,
};

const makeHarness = Effect.fn("makePartnerDecisionHarness")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const addedRules: Array<AddPolicyRuleInput> = [];
  const activities: Array<{
    readonly kind: string;
    readonly payload: unknown;
    readonly summary: string;
  }> = [];
  const taskTable = new Map<string, DeveloperTask>();
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
      const waiting = command.state === "waiting-on-bot" || command.state === "waiting-on-user";
      taskTable.set(command.taskId, {
        ...task,
        state: command.state,
        ...(command.workThreadId !== undefined ? { workThreadId: command.workThreadId } : {}),
        // The real decider keeps the ask while the task waits and clears it otherwise.
        ...(command.pendingRequest !== undefined
          ? { pendingRequest: command.pendingRequest }
          : waiting
            ? {}
            : { pendingRequest: null }),
      });
    } else if (command.type === "thread.activity.append") {
      activities.push({
        kind: command.activity.kind,
        payload: command.activity.payload,
        summary: command.activity.summary,
      });
    }
  };

  const rules = Layer.mock(PolicyRulesStore)({
    listApplicable: () => Effect.succeed([]),
    add: (input) =>
      Effect.sync(() => {
        addedRules.push(input);
        return {
          id: "rule-1",
          scope: input.scope,
          scopeId: input.scopeId ?? null,
          actionText: input.actionText,
          decision: input.decision,
          approvalClass: input.approvalClass ?? null,
          matchDetail: input.matchDetail ?? null,
          createdAt: "2026-08-01T00:00:00.000Z",
        };
      }),
  });

  const dependencies = Layer.mergeAll(
    rules,
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
      getThreadShellById: (threadId) =>
        threadId === PARENT_ID ? Effect.succeedSome(PARENT as never) : Effect.succeedNone,
      getThreadCheckpointContext: () =>
        Effect.succeedSome({
          threadId: ThreadId.make("work"),
          projectId: PROJECT_ID,
          workspaceRoot: "/work/a",
          worktreePath: "/work/a",
          checkpoints: [],
        }),
      getThreadDetailById: (threadId) =>
        threadId === PARENT_ID ? Effect.succeedSome({ activities } as never) : Effect.succeedNone,
    }),
    Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) }),
    Layer.mock(BotRegistry.BotRegistry)({
      get: () =>
        Effect.succeed({
          id: BOT_ID,
          name: "Engineer",
          autonomy: "small-changes",
          readOnly: false,
          developerEngine: null,
          canDelegate: true,
          archivedAt: null,
        } as never),
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

  const supervisorStack = DelegationSupervisor.layer.pipe(
    Layer.provide(PolicyEngine.layer.pipe(Layer.provide(rules))),
    Layer.provideMerge(PartnerWakeScheduler.layer.pipe(Layer.provide(dependencies))),
    Layer.provide(dependencies),
  );
  const services = yield* Effect.all({
    supervisor: DelegationSupervisor.DelegationSupervisor,
    decisions: PartnerDecisionService.PartnerDecisionService,
    wakes: PartnerWakeScheduler.PartnerWakeScheduler,
  }).pipe(
    Effect.provide(
      PartnerDecisionService.layer.pipe(
        Layer.provideMerge(supervisorStack),
        Layer.provide(dependencies),
      ),
    ),
  );

  const ofType = <T extends OrchestrationCommand["type"]>(type: T) =>
    Ref.get(commands).pipe(
      Effect.map((list) =>
        list.filter((command): command is Extract<OrchestrationCommand, { type: T }> => {
          return command.type === type;
        }),
      ),
    );
  const systemWakes = ofType("thread.turn.start").pipe(
    Effect.map((turns) => turns.filter((turn) => turn.message.origin === "system-wake")),
  );

  /** A running task parked on a `git push` approval, the partner already woken. */
  const parkedOnPush = Effect.gen(function* () {
    const { taskId } = yield* services.supervisor.start({
      thread: PARENT as never,
      parentTurnId: TurnId.make("turn-1"),
      botId: BOT_ID,
      brief: {
        goal: "Ship the fix",
        context: "",
        constraints: "",
        acceptance: "",
        scope: "small",
      },
    });
    yield* services.supervisor.handleEvent({
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make(`work-${taskId}`),
        activity: {
          id: "activity-1",
          kind: "approval.requested",
          payload: {
            requestId: "req-push",
            requestKind: "command",
            detail: "git push origin main",
          },
          tone: "approval",
          summary: "approval.requested",
          turnId: null,
        },
      },
    } as never);
    return taskId;
  });

  return { ...services, taskTable, addedRules, activities, ofType, systemWakes, parkedOnPush };
});

const cardIdOf = (
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
) =>
  (
    activities.find((activity) => activity.kind === "partner-decision")!.payload as {
      cardId: string;
    }
  ).cardId;

describe("PartnerDecisionService", () => {
  it.effect("ask draws a card on the parent thread and parks the task waiting-on-user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskId = yield* harness.parkedOnPush;
      assert.equal(harness.taskTable.get(taskId)!.state, "waiting-on-bot");

      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
      });

      const card = harness.activities.find((activity) => activity.kind === "partner-decision")!;
      assert.deepEqual(card.payload, {
        cardId,
        parentThreadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
        requestId: "req-push",
        approvalClass: "production",
        matchDetail: "git push origin main",
        alwaysAllow: [{ approvalClass: "production", matchDetail: "git push origin main" }],
        createdAt: (card.payload as { createdAt: string }).createdAt,
      });
      const task = harness.taskTable.get(taskId)!;
      assert.equal(task.state, "waiting-on-user");
      assert.equal(task.pendingRequest?.requestId, "req-push");

      // Asking again about the same request reuses the card.
      const again = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
        requestId: "req-push",
      });
      assert.equal(again.cardId, cardId);
      assert.equal(harness.activities.filter((a) => a.kind === "partner-decision").length, 1);
    }),
  );

  it.effect("ask refuses a task of another thread and a request the task is not waiting on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskId = yield* harness.parkedOnPush;
      const missing = yield* harness.decisions
        .ask({
          threadId: PARENT_ID,
          botId: BOT_ID,
          kind: "question",
          question: "Which one?",
          taskId: DeveloperTaskId.make("task-nope"),
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "DelegationRejectedError");
      const stale = yield* harness.decisions
        .ask({
          threadId: PARENT_ID,
          botId: BOT_ID,
          kind: "approval",
          question: "Push?",
          taskId,
          requestId: "req-old",
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "DelegationRejectedError");
      assert.deepEqual(harness.activities, []);
    }),
  );

  it.effect("a free-standing question draws a card without touching any task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "question",
        question: "Which package?",
        options: ["web", " server ", ""],
      });
      const payload = harness.activities[0]!.payload as { options: string[]; taskId?: string };
      assert.deepEqual(payload.options, ["web", "server"]);
      assert.isUndefined(payload.taskId);
      assert.equal(cardIdOf(harness.activities), cardId);
      assert.deepEqual(yield* harness.ofType("developerTask.state.set"), []);
    }),
  );

  it.effect("accept answers the developer, records the resolution, and wakes the partner", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskId = yield* harness.parkedOnPush;
      // Policy ask woke the partner once; its turn ends in ask_user.
      assert.equal((yield* harness.systemWakes).length, 1);
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
      });
      yield* harness.wakes.onPartnerTurnSettled(PARENT_ID);

      yield* harness.decisions.resolve({ cardId, parentThreadId: PARENT_ID, decision: "accept" });

      const responses = yield* harness.ofType("thread.approval.respond");
      assert.deepEqual(
        responses.map((response) => [response.threadId, response.requestId, response.decision]),
        [[`work-${taskId}`, "req-push", "accept"]],
      );
      assert.equal(harness.taskTable.get(taskId)!.state, "running");
      const resolved = harness.activities.find(
        (activity) => activity.kind === "partner-decision.resolved",
      )!;
      assert.deepEqual(resolved.payload, { cardId, decision: "accept" });
      assert.deepEqual(harness.addedRules, []);

      const wakes = yield* harness.systemWakes;
      assert.equal(wakes.length, 2);
      assert.include(wakes[1]!.message.text, 'kind="decision.resolved"');
      assert.include(wakes[1]!.message.text, "user approved");
      assert.include(wakes[1]!.message.text, "applied: the developer has your answer");
    }),
  );

  it.effect("decline tells the developer no", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskId = yield* harness.parkedOnPush;
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
      });
      yield* harness.decisions.resolve({ cardId, parentThreadId: PARENT_ID, decision: "decline" });
      const responses = yield* harness.ofType("thread.approval.respond");
      assert.deepEqual(
        responses.map((response) => response.decision),
        ["decline"],
      );
    }),
  );

  it.effect("always_allow writes a project rule for the normalized push and accepts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskId = yield* harness.parkedOnPush;
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Push to main?",
        taskId,
      });
      yield* harness.decisions.resolve({
        cardId,
        parentThreadId: PARENT_ID,
        decision: "always_allow",
      });

      assert.equal(harness.addedRules.length, 1);
      const rule = harness.addedRules[0]!;
      assert.equal(rule.scope, "project");
      assert.equal(rule.scopeId, PROJECT_ID);
      assert.equal(rule.decision, "allow");
      assert.equal(rule.approvalClass, "production");
      assert.equal(rule.matchDetail, "git push origin main");
      assert.include(rule.actionText, "git push origin main");
      const responses = yield* harness.ofType("thread.approval.respond");
      assert.deepEqual(
        responses.map((response) => response.decision),
        ["accept"],
      );
    }),
  );

  it.effect("always_allow needs a classified request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Deploy?",
      });
      const error = yield* harness.decisions
        .resolve({ cardId, parentThreadId: PARENT_ID, decision: "always_allow" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "DelegationRejectedError");
      assert.deepEqual(harness.addedRules, []);
    }),
  );

  it.effect("a question's answer is recorded and relayed to the partner only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "question",
        question: "Which package?",
        options: ["web", "server"],
      });
      const empty = yield* harness.decisions
        .resolve({ cardId, parentThreadId: PARENT_ID, decision: "accept" })
        .pipe(Effect.flip);
      assert.equal(empty._tag, "DelegationRejectedError");

      yield* harness.decisions.resolve({
        cardId,
        parentThreadId: PARENT_ID,
        decision: "accept",
        selectedOption: "server",
      });
      const resolved = harness.activities.find(
        (activity) => activity.kind === "partner-decision.resolved",
      )!;
      assert.deepEqual(resolved.payload, { cardId, decision: "answer", answerText: "server" });
      assert.deepEqual(yield* harness.ofType("thread.approval.respond"), []);
      const wakes = yield* harness.systemWakes;
      assert.include(wakes[0]!.message.text, "user answered: server");
    }),
  );

  it.effect("refuses unknown and already answered cards", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const unknown = yield* harness.decisions
        .resolve({
          cardId: PartnerDecisionCardId.make("decision-nope"),
          parentThreadId: PARENT_ID,
          decision: "accept",
        })
        .pipe(Effect.flip);
      assert.equal(unknown._tag, "DelegationRejectedError");

      const { cardId } = yield* harness.decisions.ask({
        threadId: PARENT_ID,
        botId: BOT_ID,
        kind: "approval",
        question: "Deploy?",
      });
      yield* harness.decisions.resolve({ cardId, parentThreadId: PARENT_ID, decision: "decline" });
      const twice = yield* harness.decisions
        .resolve({ cardId, parentThreadId: PARENT_ID, decision: "accept" })
        .pipe(Effect.flip);
      assert.equal(twice._tag, "DelegationRejectedError");
      assert.equal(
        harness.activities.filter((activity) => activity.kind === "partner-decision.resolved")
          .length,
        1,
      );
    }),
  );
});
