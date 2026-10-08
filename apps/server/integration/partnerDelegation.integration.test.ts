// @effect-diagnostics nodeBuiltinImport:off
/**
 * HYBRID Phase 3.5: a partner thread delegates to a developer through the live stack.
 *
 * Real layers: OrchestrationEngine, projections, ProviderCommandReactor, ProviderRuntimeIngestion,
 * CheckpointReactor, BotRegistry (built-in Engineer), DelegationSupervisor, PartnerApprovalBackstop,
 * and the partner toolkit handlers. Only the provider adapter is fake.
 *
 * The fake provider cannot speak MCP, so the "bot" calls `start_developer_task` by invoking the
 * PartnerToolkit handlers directly with a partner-capability credential. That is the same code the
 * MCP server runs for a tool call; only the HTTP transport and the credential issue are skipped.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BUILTIN_BOT_IDS,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  defaultInstanceIdForDriver,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { DelegationSupervisor } from "../src/bots/DelegationSupervisor.ts";
import * as DeveloperTaskLiveStatus from "../src/bots/DeveloperTaskLiveStatus.ts";
import { PartnerDecisionService } from "../src/bots/PartnerDecisionService.ts";
import * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import { PartnerToolkitHandlersLive } from "../src/mcp/toolkits/partner/handlers.ts";
import { PartnerToolkit } from "../src/mcp/toolkits/partner/tools.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const CODEX = ProviderDriverKind.make("codex");
const PROJECT_ID = ProjectId.make("project-partner");
const PARTNER_THREAD_ID = ThreadId.make("thread-partner");
const PARTNER_APPROVAL_ID = "req-partner-approval";
const DEVELOPER_APPROVAL_ID = "req-developer-approval";
const CREATED_AT = "2026-08-01T00:00:00.000Z";
const FIXTURE_TURN_ID = "fixture-turn";

/** Polls an in-memory fact of the fake provider (the projection is awaited through the harness). */
function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      const value = read();
      if (predicate(value)) return value;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(`Timed out waiting for ${description}`));
      }
      yield* Effect.sleep(10);
    }
  });
}

const workThreadIdOf = (taskId: string) => ThreadId.make(`work-${taskId}`);

const base = (eventId: string) => ({
  eventId: EventId.make(eventId),
  provider: CODEX,
  createdAt: CREATED_AT,
});

const partnerTurn: TestTurnResponse = {
  events: [
    {
      type: "turn.started",
      ...base("evt-partner-1"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    {
      // A partner is read-only: this request must never reach the user.
      type: "approval.requested",
      ...base("evt-partner-2"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      requestId: PARTNER_APPROVAL_ID,
      requestKind: "command",
      detail: "rm -rf /",
    },
    {
      type: "message.delta",
      ...base("evt-partner-3"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      delta: "Handing this to the developer.\n",
    },
    {
      type: "turn.completed",
      ...base("evt-partner-4"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      status: "completed",
    },
  ],
};

/** A developer turn: asks to run the tests, edits a file, and finishes. */
const developerTurn = (input: {
  readonly tag: string;
  readonly approvalId: string | null;
  readonly file: string;
  readonly summary: string;
  /** Held inside the provider call, so the turn stays running until released. */
  readonly gate: Deferred.Deferred<void> | null;
}): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...base(`evt-${input.tag}-1`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    ...(input.approvalId === null
      ? []
      : [
          {
            type: "approval.requested",
            ...base(`evt-${input.tag}-2`),
            threadId: PARTNER_THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: input.approvalId,
            requestKind: "command",
            detail: "pnpm test",
          },
        ]),
    {
      type: "message.delta",
      ...base(`evt-${input.tag}-3`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      delta: input.summary,
    },
    {
      type: "turn.completed",
      ...base(`evt-${input.tag}-4`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      status: "completed",
    },
  ],
  mutateWorkspace: ({ cwd }) =>
    (input.gate === null ? Effect.void : Deferred.await(input.gate)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          NodeFS.writeFileSync(NodePath.join(cwd, input.file), `${input.tag}\n`, "utf8");
        }),
      ),
    ),
});

const withPartnerHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX, partnerDelegation: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));

const seedPartnerThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const modelSelection = {
      instanceId: defaultInstanceIdForDriver(CODEX),
      model: DEFAULT_MODEL_BY_PROVIDER[CODEX] ?? DEFAULT_MODEL,
    };
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Partner Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: modelSelection,
      createdAt: CREATED_AT,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-partner-thread-create"),
      threadId: PARTNER_THREAD_ID,
      projectId: PROJECT_ID,
      title: "Partner conversation",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt: CREATED_AT,
      kind: "chat",
      parentThreadId: null,
      partnerBotId: BUILTIN_BOT_IDS.engineer,
    });
  });

/** The partner toolkit's own handlers, wired to the harness's live services. */
const makePartnerTools = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const supervisor = harness.delegationSupervisor;
    assert.isNotNull(supervisor);
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectionSnapshotQuery, harness.snapshotQuery),
      Layer.succeed(DelegationSupervisor, supervisor!),
      // ask_user is covered by PartnerDecisionService.test.ts; these tools do not call it.
      Layer.mock(PartnerDecisionService)({}),
      DeveloperTaskLiveStatus.layer,
    );
    const toolkit = yield* PartnerToolkit.pipe(
      Effect.provide(PartnerToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-integration"),
      threadId: PARTNER_THREAD_ID,
      providerSessionId: "provider-session-partner",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["partner"]),
      issuedAt: 1,
    };
    return <Name extends keyof typeof PartnerToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PartnerToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(dependencies),
      );
  });

const isTaskState = (taskId: string, state: string) => (event: OrchestrationEvent) =>
  event.type === "developer-task.state-set" &&
  event.payload.taskId === taskId &&
  event.payload.state === state;

it.live(
  "partner delegates through start_developer_task: work thread runs, approvals follow the rules, tasks queue per worktree",
  () =>
    withPartnerHarness((harness) =>
      Effect.gen(function* () {
        const adapter = harness.adapterHarness!;
        yield* seedPartnerThread(harness);
        const callTool = yield* makePartnerTools(harness);

        // —— the partner's own turn: it asks for an approval, which must be declined ——
        yield* adapter.queueTurnResponseForNextSession(partnerTurn);
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-partner-turn-start"),
          threadId: PARTNER_THREAD_ID,
          message: {
            messageId: MessageId.make("msg-partner-user"),
            role: "user",
            text: "Please add the feature file.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: CREATED_AT,
        });

        // 3. PartnerApprovalBackstop declines the partner-thread approval.
        const partnerApproval = yield* harness.waitForPendingApproval(
          PARTNER_APPROVAL_ID,
          (row) => row.status === "resolved",
        );
        assert.equal(partnerApproval.decision, "decline");
        const partnerResponses = yield* waitForSync(
          () => adapter.getApprovalResponses(PARTNER_THREAD_ID),
          (responses) => responses.length === 1,
          "the partner approval decline to reach the provider",
        );
        assert.deepEqual(
          partnerResponses.map((response) => [response.requestId, response.decision]),
          [[PARTNER_APPROVAL_ID, "decline"]],
        );

        yield* harness.waitForThread(
          PARTNER_THREAD_ID,
          (thread) => thread.latestTurn?.state === "completed",
        );
        assert.equal(adapter.getStartCountForThread(PARTNER_THREAD_ID), 1);

        // System wakes (task completed, etc.) start more partner turns on the same session.
        const quietWake = (index: number): TestTurnResponse => ({
          events: [
            {
              type: "turn.started",
              ...base(`evt-wake-${index}-1`),
              threadId: PARTNER_THREAD_ID,
              turnId: `wake-turn-${index}`,
            },
            {
              type: "message.delta",
              ...base(`evt-wake-${index}-2`),
              threadId: PARTNER_THREAD_ID,
              turnId: `wake-turn-${index}`,
              delta: "Noted.\n",
            },
            {
              type: "turn.completed",
              ...base(`evt-wake-${index}-3`),
              threadId: PARTNER_THREAD_ID,
              turnId: `wake-turn-${index}`,
              status: "completed",
            },
          ],
        });
        for (let index = 0; index < 6; index += 1) {
          yield* adapter.queueTurnResponse(PARTNER_THREAD_ID, quietWake(index));
        }

        // —— the bot calls start_developer_task ——
        // The partner session is already up, so the next session to start is the work thread's.
        const gate = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "dev-one",
            approvalId: DEVELOPER_APPROVAL_ID,
            file: "feature.txt",
            summary: "Added feature.txt and ran pnpm test: all green.",
            gate,
          }),
        );
        const first = yield* callTool("start_developer_task", {
          goal: "Add feature.txt",
          acceptance: "pnpm test passes",
        });
        assert.equal(first.status, "started");
        const firstWorkThreadId = workThreadIdOf(first.taskId);

        // 1. The work thread exists on the partner's worktree and is running.
        const firstWork = yield* harness.waitForThread(
          firstWorkThreadId,
          (thread) => thread.session?.status === "running",
        );
        assert.equal(firstWork.kind, "work");
        assert.equal(firstWork.parentThreadId, PARTNER_THREAD_ID);
        assert.equal(firstWork.partnerBotId ?? null, null);
        assert.equal(firstWork.worktreePath, harness.workspaceDir);
        assert.equal(firstWork.projectId, PROJECT_ID);
        const sessions = yield* adapter.adapter.listSessions();
        const cwdOf = (threadId: ThreadId) =>
          sessions.find((session) => session.threadId === threadId)?.cwd;
        assert.equal(cwdOf(firstWorkThreadId), harness.workspaceDir);
        assert.equal(cwdOf(PARTNER_THREAD_ID), harness.workspaceDir);

        // 4. A second writing task on the same worktree queues behind the first.
        const second = yield* callTool("start_developer_task", {
          goal: "Add second.txt",
        });
        assert.equal(second.status, "queued");
        assert.notEqual(second.taskId, first.taskId);
        const secondGate = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForThreadStart(
          workThreadIdOf(second.taskId),
          developerTurn({
            tag: "dev-two",
            approvalId: null,
            file: "second.txt",
            summary: "Added second.txt.",
            gate: secondGate,
          }),
        );
        const whileFirstRuns = yield* callTool("check_developer_task", { taskId: second.taskId });
        assert.equal(whileFirstRuns.state, "queued");
        const runningSnapshot = yield* harness.snapshotQuery.getSnapshot();
        assert.isFalse(
          runningSnapshot.threads.some((thread) => thread.id === workThreadIdOf(second.taskId)),
          "a queued task must not have a work thread yet",
        );
        assert.equal(
          (yield* callTool("check_developer_task", { taskId: first.taskId })).state,
          "running",
        );

        // The pre-turn baseline must exist before the developer edits, or the diff is empty.
        yield* harness.waitForReceipt(
          (receipt) =>
            receipt.type === "checkpoint.baseline.captured" &&
            receipt.threadId === firstWorkThreadId,
        );
        // 1. The developer's approval goes through the interim rule: `pnpm test` is accepted.
        yield* Deferred.succeed(gate, undefined);
        const developerApproval = yield* harness.waitForPendingApproval(
          DEVELOPER_APPROVAL_ID,
          (row) => row.status === "resolved",
        );
        assert.equal(developerApproval.decision, "accept");
        const developerResponses = yield* waitForSync(
          () => adapter.getApprovalResponses(firstWorkThreadId),
          (responses) => responses.length === 1,
          "the developer approval to reach the provider",
        );
        assert.deepEqual(
          developerResponses.map((response) => [response.requestId, response.decision]),
          [[DEVELOPER_APPROVAL_ID, "accept"]],
        );

        // 1. The task completes with a result built from the checkpoint and the final message.
        const completedEvents = yield* harness.waitForDomainEvent(
          isTaskState(first.taskId, "completed"),
        );
        const firstCompleted = completedEvents.find(isTaskState(first.taskId, "completed"))!;
        assert.equal(firstCompleted.type, "developer-task.state-set");
        const result =
          firstCompleted.type === "developer-task.state-set" ? firstCompleted.payload.result : null;
        assert.isNotNull(result ?? null);
        assert.include(result!.summary, "Added feature.txt");
        assert.deepEqual(
          result!.filesChanged.map((file) => file.path),
          ["feature.txt"],
        );

        const checked = yield* callTool("check_developer_task", { taskId: first.taskId });
        assert.equal(checked.state, "completed");
        assert.equal(checked.result?.summary, result!.summary);
        assert.equal(checked.failure, null);

        const activityEvents = yield* harness.waitForDomainEvent(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.threadId === PARTNER_THREAD_ID &&
            event.payload.activity.kind === "developer-task.completed",
        );
        const completedActivity = activityEvents.find(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.threadId === PARTNER_THREAD_ID &&
            event.payload.activity.kind === "developer-task.completed",
        );
        assert.isDefined(completedActivity);
        if (completedActivity?.type === "thread.activity-appended") {
          const payload = completedActivity.payload.activity.payload as {
            taskId?: string;
            result?: { summary?: string };
          };
          assert.equal(payload.taskId, first.taskId);
          assert.equal(payload.result?.summary, result!.summary);
          assert.include(completedActivity.payload.activity.summary, "Added feature.txt");
        }

        const projectedFirst = (yield* harness.snapshotQuery.getSnapshot()).developerTasks?.find(
          (task) => task.taskId === first.taskId,
        );
        assert.equal(projectedFirst?.state, "completed");
        assert.equal(projectedFirst?.parentThreadId, PARTNER_THREAD_ID);
        assert.equal(projectedFirst?.workThreadId, firstWorkThreadId);
        // Bot autonomy "small-changes" + small scope: never derived from model text.
        assert.equal(projectedFirst?.runtimeMode, "auto-accept-edits");

        // 4. The queued task is promoted only after the holder finished, then runs to completion.
        const secondWorkThreadId = workThreadIdOf(second.taskId);
        yield* harness.waitForReceipt(
          (receipt) =>
            receipt.type === "checkpoint.baseline.captured" &&
            receipt.threadId === secondWorkThreadId,
        );
        yield* Deferred.succeed(secondGate, undefined);
        const secondEvents = yield* harness.waitForDomainEvent(
          isTaskState(second.taskId, "completed"),
        );
        const sequenceOf = (predicate: (event: OrchestrationEvent) => boolean) =>
          secondEvents.find(predicate)!.sequence;
        const firstDone = sequenceOf(isTaskState(first.taskId, "completed"));
        const secondWorkCreated = sequenceOf(
          (event) =>
            event.type === "thread.created" && event.payload.threadId === secondWorkThreadId,
        );
        assert.isAbove(
          secondWorkCreated,
          firstDone,
          "the queued task's work thread is created only after the holder completes",
        );
        const secondDone = yield* callTool("check_developer_task", { taskId: second.taskId });
        assert.equal(secondDone.state, "completed");
        assert.deepEqual(
          secondDone.result?.filesChanged.map((file) => file.path),
          ["second.txt"],
        );

        // 2. The partner session never restarted, and neither did the work sessions.
        assert.equal(adapter.getStartCountForThread(PARTNER_THREAD_ID), 1);
        assert.equal(adapter.getStopCountForThread(PARTNER_THREAD_ID), 0);
        assert.equal(adapter.getStartCountForThread(firstWorkThreadId), 1);
        assert.equal(adapter.getStartCountForThread(secondWorkThreadId), 1);
        assert.equal(adapter.getStartCount(), 3);

        // 3. Nothing was ever left waiting for the user on the partner thread.
        const partnerThread = yield* harness.waitForThread(PARTNER_THREAD_ID, () => true);
        assert.isFalse(partnerThread.session?.status === "error");
        assert.deepEqual(
          adapter.getApprovalResponses(PARTNER_THREAD_ID).map((response) => response.decision),
          ["decline"],
        );
      }),
    ),
  60_000,
);
