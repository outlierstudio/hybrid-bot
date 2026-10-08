import {
  BotId,
  DeveloperTaskId,
  EnvironmentId,
  PartnerDecisionCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DeveloperTask,
  type DeveloperTaskBrief,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import {
  DelegationRejectedError,
  DelegationSupervisor,
} from "../../../bots/DelegationSupervisor.ts";
import * as DeveloperTaskLiveStatus from "../../../bots/DeveloperTaskLiveStatus.ts";
import { PartnerDecisionService } from "../../../bots/PartnerDecisionService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PartnerToolkitHandlersLive } from "./handlers.ts";
import { PartnerToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-chat");
const OTHER_THREAD_ID = ThreadId.make("thread-other");
const BOT_ID = BotId.make("bot-1");
const TURN_ID = TurnId.make("turn-1");
const TASK_ID = DeveloperTaskId.make("task-1");
const NOW = "2026-08-01T00:00:00.000Z";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    kind: "chat",
    partnerBotId: BOT_ID,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const makeTask = (overrides: Partial<DeveloperTask> = {}): DeveloperTask => ({
  taskId: TASK_ID,
  parentThreadId: THREAD_ID,
  parentTurnId: TURN_ID,
  workThreadId: null,
  workTurnIds: [],
  botId: BOT_ID,
  brief: { goal: "Ship it", context: "", constraints: "", acceptance: "", scope: "small" },
  runtimeMode: "auto",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  state: "queued",
  pendingRequest: null,
  result: null,
  failure: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  completedAt: null,
  ...overrides,
});

type SupervisorCall =
  | { readonly op: "start"; readonly botId: BotId; readonly brief: DeveloperTaskBrief }
  | { readonly op: "message"; readonly taskId: string; readonly text: string }
  | { readonly op: "answer"; readonly taskId: string; readonly requestId: string }
  | { readonly op: "stop"; readonly taskId: string }
  | {
      readonly op: "ask";
      readonly threadId: string;
      readonly botId: string;
      readonly kind: string;
      readonly question: string;
      readonly taskId: string | undefined;
      readonly requestId: string | undefined;
    };

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell | null;
  readonly tasks?: ReadonlyArray<DeveloperTask>;
}

const makeHarness = Effect.fn("makePartnerToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<SupervisorCall>>([]);
  const record = (call: SupervisorCall) => Ref.update(calls, (recorded) => [...recorded, call]);
  const thread = options.thread === undefined ? makeThread() : options.thread;
  // A fake supervisor: start "creates" the task so a later check can read it back.
  const tasks = yield* Ref.make<ReadonlyArray<DeveloperTask>>(options.tasks ?? []);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.fromNullishOr(thread) : Option.none()),
    }),
    Layer.succeed(DelegationSupervisor, {
      start: (input) =>
        Effect.gen(function* () {
          yield* record({ op: "start", botId: input.botId, brief: input.brief });
          const task = makeTask({
            parentThreadId: input.thread.id,
            parentTurnId: input.parentTurnId,
            botId: input.botId,
            brief: input.brief,
          });
          yield* Ref.update(tasks, (all) => [...all, task]);
          return { taskId: task.taskId, status: "started" as const };
        }),
      check: (taskId) =>
        Ref.get(tasks).pipe(
          Effect.map((all) => Option.fromNullishOr(all.find((task) => task.taskId === taskId))),
        ),
      message: (input) => record({ op: "message", taskId: input.taskId, text: input.text }),
      answer: (input) =>
        input.requestId === "stale"
          ? Effect.fail(new DelegationRejectedError({ reason: "not waiting" }))
          : record({ op: "answer", taskId: input.taskId, requestId: input.requestId }),
      stop: (taskId) => record({ op: "stop", taskId }),
      watch: () => Effect.succeed(Stream.empty),
      confirm: () => Effect.void,
      decline: () => Effect.void,
      edit: () => Effect.void,
      startReactor: () => Effect.void,
      handleEvent: () => Effect.void,
    }),
    Layer.succeed(PartnerDecisionService, {
      ask: (input) =>
        record({
          op: "ask",
          threadId: input.threadId,
          botId: input.botId,
          kind: input.kind,
          question: input.question,
          taskId: input.taskId,
          requestId: input.requestId,
        }).pipe(Effect.as({ cardId: PartnerDecisionCardId.make("decision-1") })),
      resolve: () => Effect.void,
    }),
    DeveloperTaskLiveStatus.layer,
  );
  const toolkit = yield* PartnerToolkit.pipe(
    Effect.provide(PartnerToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof PartnerToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["partner"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PartnerToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { calls, call };
});

describe("partner toolkit handlers", () => {
  it.effect("refuses a credential without the partner capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ tasks: [makeTask()] });
      const error = yield* harness
        .call("check_developer_task", { taskId: TASK_ID }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "partner",
        threadId: THREAD_ID,
      });
      const started = yield* harness
        .call("start_developer_task", { goal: "Ship it" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(started).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("refuses a work thread and a chat thread with no partner", () =>
    Effect.gen(function* () {
      const work = yield* makeHarness({ thread: makeThread({ kind: "work" }) });
      expect(
        yield* work.call("start_developer_task", { goal: "x" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PartnerNotAvailableError", threadId: THREAD_ID });
      const unbound = yield* makeHarness({ thread: makeThread({ partnerBotId: null }) });
      expect(
        yield* unbound.call("start_developer_task", { goal: "x" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PartnerNotAvailableError" });
      const missing = yield* makeHarness({ thread: null });
      expect(
        yield* missing.call("start_developer_task", { goal: "x" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PartnerThreadNotFoundError" });
      for (const harness of [work, unbound, missing]) {
        expect(yield* Ref.get(harness.calls)).toEqual([]);
      }
    }),
  );

  it.effect("treats a thread with no kind as a chat thread", () =>
    Effect.gen(function* () {
      const { kind: _kind, ...legacy } = makeThread();
      const harness = yield* makeHarness({ thread: legacy });
      const result = yield* harness.call("start_developer_task", { goal: "x" });
      expect(result.status).toBe("started");
    }),
  );

  it.effect("starts a task with the thread's bot and fills brief defaults", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.call("start_developer_task", {
        goal: "Ship it",
        acceptance: "pnpm test",
      });
      expect(started).toEqual({ taskId: TASK_ID, status: "started" });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          op: "start",
          botId: BOT_ID,
          brief: {
            goal: "Ship it",
            context: "",
            constraints: "",
            acceptance: "pnpm test",
            scope: "small",
          },
        },
      ]);
      const checked = yield* harness.call("check_developer_task", { taskId: started.taskId });
      expect(checked).toMatchObject({
        taskId: TASK_ID,
        goal: "Ship it",
        state: "queued",
        pendingRequest: null,
        result: null,
        failure: null,
      });
    }),
  );

  it.effect("needs an active turn to start work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: makeThread({ latestTurn: null }) });
      expect(
        yield* harness.call("start_developer_task", { goal: "x" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PartnerTurnRequiredError" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("hides tasks of another thread or another bot as not found", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        tasks: [
          makeTask({
            taskId: DeveloperTaskId.make("other-thread"),
            parentThreadId: OTHER_THREAD_ID,
          }),
          makeTask({ taskId: DeveloperTaskId.make("other-bot"), botId: BotId.make("bot-2") }),
        ],
      });
      for (const id of ["other-thread", "other-bot", "unknown"]) {
        const taskId = DeveloperTaskId.make(id);
        const errors = [
          yield* harness.call("check_developer_task", { taskId }).pipe(Effect.flip),
          yield* harness.call("message_developer", { taskId, text: "hi" }).pipe(Effect.flip),
          yield* harness
            .call("answer_developer", { taskId, requestId: "r", decision: "accept" })
            .pipe(Effect.flip),
          yield* harness.call("stop_developer_task", { taskId }).pipe(Effect.flip),
        ];
        for (const error of errors) {
          expect(error).toMatchObject({ _tag: "DeveloperTaskNotFoundError", taskId: id });
        }
      }
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("steers, answers, and stops an owned task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ tasks: [makeTask()] });
      expect(
        yield* harness.call("message_developer", { taskId: TASK_ID, text: "Use the helper." }),
      ).toEqual({ status: "sent" });
      expect(
        yield* harness.call("answer_developer", {
          taskId: TASK_ID,
          requestId: "request-1",
          decision: "decline",
        }),
      ).toEqual({ status: "answered" });
      expect(yield* harness.call("stop_developer_task", { taskId: TASK_ID })).toEqual({
        status: "stopped",
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        { op: "message", taskId: TASK_ID, text: "Use the helper." },
        { op: "answer", taskId: TASK_ID, requestId: "request-1" },
        { op: "stop", taskId: TASK_ID },
      ]);
    }),
  );

  it.effect("message_developer on a terminal task returns task_finished without steering", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        tasks: [
          makeTask({ state: "failed", failure: { code: "interrupted", message: "stopped" } }),
        ],
      });
      expect(
        yield* harness.call("message_developer", { taskId: TASK_ID, text: "also add a test" }),
      ).toEqual({ status: "task_finished" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("ask_user draws a card for the caller's thread and bot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ tasks: [makeTask()] });
      expect(
        yield* harness.call("ask_user", {
          question: "Push to main?",
          kind: "approval",
          taskId: TASK_ID,
          requestId: "request-1",
        }),
      ).toEqual({ cardId: "decision-1" });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          op: "ask",
          threadId: THREAD_ID,
          botId: BOT_ID,
          kind: "approval",
          question: "Push to main?",
          taskId: TASK_ID,
          requestId: "request-1",
        },
      ]);
    }),
  );

  it.effect("ask_user needs the partner capability and an owned task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        tasks: [
          makeTask({ taskId: DeveloperTaskId.make("other-bot"), botId: BotId.make("bot-2") }),
        ],
      });
      expect(
        yield* harness
          .call("ask_user", { question: "Ok?", kind: "question" }, ["pull-requests"])
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "partner" });
      expect(
        yield* harness
          .call("ask_user", {
            question: "Ok?",
            kind: "question",
            taskId: DeveloperTaskId.make("other-bot"),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DeveloperTaskNotFoundError" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("surfaces a supervisor rejection to the bot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ tasks: [makeTask()] });
      const error = yield* harness
        .call("answer_developer", { taskId: TASK_ID, requestId: "stale", decision: "accept" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DelegationRejectedError", reason: "not waiting" });
    }),
  );
});
