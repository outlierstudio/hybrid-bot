// @effect-diagnostics nodeBuiltinImport:off
/**
 * HYBRID: Always-allow end to end, with the fake provider as the only fake.
 *
 * Real layers: OrchestrationEngine, projections, ProviderCommandReactor, ProviderRuntimeIngestion,
 * BotRegistry (built-in Engineer, small-changes), DelegationSupervisor, real PolicyEngine over a
 * SQLite-backed PolicyRulesStore, and PartnerDecisionService. The fake provider cannot speak MCP,
 * so the partner's `start_developer_task` / `ask_user` calls go through the PartnerToolkit handlers
 * directly (the same code the MCP server runs), and the user's click is
 * `PartnerDecisionService.resolve`. Each developer task is its own work thread with one request,
 * held open by a gate so the task stays parked while the user decides.
 */
import {
  BUILTIN_BOT_IDS,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  EventId,
  MessageId,
  PARTNER_DECISION_ACTIVITY_KIND,
  PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  defaultInstanceIdForDriver,
  type DeveloperTask,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
const PROJECT_ID = ProjectId.make("project-always-allow");
const PARTNER_THREAD_ID = ThreadId.make("thread-partner-always-allow");
const CREATED_AT = "2026-08-01T00:00:00.000Z";
const FIXTURE_TURN_ID = "fixture-turn";

const PUSH_MAIN = "git push origin main";
const PUSH_OTHER_REMOTE = "git push upstream main";
const INSTALL = "pnpm add left-pad";

/** Polls an in-memory fact of the fake provider. */
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

/**
 * A partner turn that says something and stops. Used for the opening turn and for every
 * system wake, so no partner session ever errors on an empty fake queue.
 */
const quietPartnerTurn: TestTurnResponse = {
  events: [
    {
      type: "turn.started",
      ...base("evt-partner-quiet-1"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    {
      type: "message.delta",
      ...base("evt-partner-quiet-2"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      delta: "On it.\n",
    },
    {
      type: "turn.completed",
      ...base("evt-partner-quiet-3"),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      status: "completed",
    },
  ],
};

/**
 * A developer turn that asks to run each command, then stays open on the gate until released.
 * The fake provider emits the requests up front; the gate keeps the task from finishing.
 */
const developerTurn = (input: {
  readonly tag: string;
  readonly requests: ReadonlyArray<{ readonly requestId: string; readonly command: string }>;
  readonly gate: Deferred.Deferred<void>;
}): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...base(`evt-${input.tag}-start`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    ...input.requests.map((request, index) => ({
      type: "approval.requested",
      ...base(`evt-${input.tag}-request-${index}`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      requestId: request.requestId,
      requestKind: "command",
      detail: request.command,
    })),
    {
      type: "message.delta",
      ...base(`evt-${input.tag}-summary`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      delta: `${input.tag} done.`,
    },
    {
      type: "turn.completed",
      ...base(`evt-${input.tag}-end`),
      threadId: PARTNER_THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      status: "completed",
    },
  ],
  mutateWorkspace: () => Deferred.await(input.gate),
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
      title: "Always Allow Project",
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

/** The partner toolkit's handlers over the harness's live supervisor and decision service. */
const makePartnerTools = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const supervisor = harness.delegationSupervisor;
    const decisions = harness.partnerDecisions;
    assert.isNotNull(supervisor);
    assert.isNotNull(decisions);
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectionSnapshotQuery, harness.snapshotQuery),
      Layer.succeed(DelegationSupervisor, supervisor!),
      Layer.succeed(PartnerDecisionService, decisions!),
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

const readEvents = (harness: OrchestrationIntegrationHarness) =>
  Stream.runCollect(harness.engine.readEvents(0)).pipe(
    Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
  );

const decisionCardIds = (events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "thread.activity-appended" &&
    event.payload.threadId === PARTNER_THREAD_ID &&
    event.payload.activity.kind === PARTNER_DECISION_ACTIVITY_KIND
      ? [(event.payload.activity.payload as { cardId: string }).cardId]
      : [],
  );

const resolvedCards = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.flatMap((event) =>
    event.type === "thread.activity-appended" &&
    event.payload.threadId === PARTNER_THREAD_ID &&
    event.payload.activity.kind === PARTNER_DECISION_RESOLVED_ACTIVITY_KIND
      ? [event.payload.activity.payload as { cardId: string; decision: string }]
      : [],
  );

it.live(
  "Always allow on `git push origin main` auto-accepts the next identical push, still asks for another remote, and installs need no card",
  () =>
    withPartnerHarness((harness) =>
      Effect.gen(function* () {
        const adapter = harness.adapterHarness!;
        const supervisor = harness.delegationSupervisor!;
        const decisions = harness.partnerDecisions!;
        const rules = harness.policyRules!;
        yield* seedPartnerThread(harness);
        const callTool = yield* makePartnerTools(harness);

        // The partner takes a turn (its latest turn parents the tasks), and every later
        // system wake gets a quiet turn of its own.
        for (let index = 0; index < 8; index += 1) {
          yield* adapter.queueTurnResponseForThreadStart(PARTNER_THREAD_ID, quietPartnerTurn);
        }
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-partner-turn-start"),
          threadId: PARTNER_THREAD_ID,
          message: {
            messageId: MessageId.make("msg-partner-user"),
            role: "user",
            text: "Please push the fix.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: CREATED_AT,
        });
        yield* harness.waitForThread(
          PARTNER_THREAD_ID,
          (thread) => thread.latestTurn?.state === "completed",
        );

        const taskOf = (taskId: string): Effect.Effect<DeveloperTask> =>
          supervisor
            .check(taskId as DeveloperTask["taskId"])
            .pipe(Effect.map(Option.getOrThrow), Effect.orDie);
        const responsesOf = (taskId: string) =>
          adapter
            .getApprovalResponses(workThreadIdOf(taskId))
            .map((response) => [response.requestId as string, response.decision] as const);

        // The Engineer is "small-changes": a small brief starts without a plan card.
        const startTask = (goal: string) =>
          callTool("start_developer_task", { goal, acceptance: "done", scope: "small" });

        // —— 1–2. A work thread asks to `git push origin main`; policy asks ——
        const gate1 = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "push-first",
            requests: [{ requestId: "req-push-1", command: PUSH_MAIN }],
            gate: gate1,
          }),
        );
        const first = yield* startTask("Push the fix");
        assert.equal(first.status, "started");
        yield* harness.waitForDomainEvent(isTaskState(first.taskId, "waiting-on-bot"));
        const firstParked = yield* taskOf(first.taskId);
        assert.equal(firstParked.pendingRequest?.requestId, "req-push-1");
        assert.equal(firstParked.pendingRequest?.approvalClass, "production");
        assert.equal(firstParked.pendingRequest?.matchDetail, PUSH_MAIN);
        // Policy did not answer for the user: nothing reached the provider.
        assert.deepEqual(responsesOf(first.taskId), []);
        assert.deepEqual(decisionCardIds(yield* readEvents(harness)), []);
        assert.deepEqual(yield* rules.list(), []);

        // —— 3. The partner puts it to the user: a decision card is drawn ——
        const { cardId } = yield* callTool("ask_user", {
          kind: "approval",
          question: "The developer wants to push to origin/main. OK?",
          taskId: first.taskId,
          requestId: "req-push-1",
        });
        assert.deepEqual(decisionCardIds(yield* readEvents(harness)), [cardId]);
        assert.equal((yield* taskOf(first.taskId)).state, "waiting-on-user");

        // —— 4. The user picks Always allow ——
        yield* decisions.resolve({
          cardId,
          parentThreadId: PARTNER_THREAD_ID,
          decision: "always_allow",
        });
        const stored = yield* rules.list();
        assert.equal(stored.length, 1);
        assert.equal(stored[0]!.scope, "project");
        assert.equal(stored[0]!.scopeId, PROJECT_ID);
        assert.equal(stored[0]!.decision, "allow");
        assert.equal(stored[0]!.approvalClass, "production");
        assert.equal(stored[0]!.matchDetail, PUSH_MAIN);
        yield* waitForSync(
          () => responsesOf(first.taskId),
          (responses) => responses.length === 1,
          "the first push to be accepted",
        );
        assert.deepEqual(responsesOf(first.taskId), [["req-push-1", "accept"]]);
        assert.deepEqual(
          resolvedCards(yield* readEvents(harness)).map((entry) => [entry.cardId, entry.decision]),
          [[cardId, "always_allow"]],
        );
        yield* Deferred.succeed(gate1, undefined);
        yield* harness.waitForDomainEvent(isTaskState(first.taskId, "completed"));

        // —— 5, 7. The same push again, and an install, are accepted with no new card ——
        const gate2 = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "push-again",
            requests: [
              { requestId: "req-push-2", command: PUSH_MAIN },
              { requestId: "req-install-2", command: INSTALL },
            ],
            gate: gate2,
          }),
        );
        const second = yield* startTask("Push the fix again");
        assert.equal(second.status, "started");
        yield* waitForSync(
          () => responsesOf(second.taskId),
          (responses) => responses.length === 2,
          "the repeated push and the install to be accepted",
        );
        assert.sameDeepMembers(
          responsesOf(second.taskId).map((entry) => [...entry]),
          [
            ["req-push-2", "accept"],
            ["req-install-2", "accept"],
          ],
        );
        assert.equal((yield* taskOf(second.taskId)).state, "running");
        const afterSecond = yield* readEvents(harness);
        assert.isFalse(
          afterSecond.some(isTaskState(second.taskId, "waiting-on-bot")),
          "an allowed request never parks the task",
        );
        assert.isFalse(afterSecond.some(isTaskState(second.taskId, "waiting-on-user")));
        assert.deepEqual(decisionCardIds(afterSecond), [cardId], "no new card was drawn");
        assert.equal((yield* rules.list()).length, 1, "no extra rule was written");
        yield* Deferred.succeed(gate2, undefined);
        yield* harness.waitForDomainEvent(isTaskState(second.taskId, "completed"));

        // —— 6. A push to another remote still asks, with its own card ——
        const gate3 = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "push-other",
            requests: [{ requestId: "req-push-3", command: PUSH_OTHER_REMOTE }],
            gate: gate3,
          }),
        );
        const third = yield* startTask("Push to the other remote");
        assert.equal(third.status, "started");
        yield* harness.waitForDomainEvent(isTaskState(third.taskId, "waiting-on-bot"));
        const thirdParked = yield* taskOf(third.taskId);
        assert.equal(thirdParked.pendingRequest?.matchDetail, PUSH_OTHER_REMOTE);
        assert.deepEqual(responsesOf(third.taskId), []);

        const other = yield* callTool("ask_user", {
          kind: "approval",
          question: "The developer wants to push to upstream/main. OK?",
          taskId: third.taskId,
          requestId: "req-push-3",
        });
        assert.notEqual(other.cardId, cardId);
        assert.deepEqual(decisionCardIds(yield* readEvents(harness)), [cardId, other.cardId]);
        assert.equal((yield* taskOf(third.taskId)).state, "waiting-on-user");
        assert.equal((yield* rules.list()).length, 1);

        // Deny: the provider is told no, and still no rule exists for this remote.
        yield* decisions.resolve({
          cardId: other.cardId,
          parentThreadId: PARTNER_THREAD_ID,
          decision: "decline",
        });
        yield* waitForSync(
          () => responsesOf(third.taskId),
          (responses) => responses.length === 1,
          "the other remote's push to be declined",
        );
        assert.deepEqual(responsesOf(third.taskId), [["req-push-3", "decline"]]);
        assert.equal((yield* rules.list()).length, 1);
        yield* Deferred.succeed(gate3, undefined);
        yield* harness.waitForDomainEvent(isTaskState(third.taskId, "completed"));
      }),
    ),
  90_000,
);

const chainedPush = (message: string) =>
  `printf 'x' > notes.md && git add notes.md && git commit -m "${message}" && git push origin master`;

it.live(
  "Always allow on a chained push remembers only `git push origin master`, so the next push with a different commit message gets no card",
  () =>
    withPartnerHarness((harness) =>
      Effect.gen(function* () {
        const adapter = harness.adapterHarness!;
        const supervisor = harness.delegationSupervisor!;
        const decisions = harness.partnerDecisions!;
        const rules = harness.policyRules!;
        yield* seedPartnerThread(harness);
        const callTool = yield* makePartnerTools(harness);

        for (let index = 0; index < 6; index += 1) {
          yield* adapter.queueTurnResponseForThreadStart(PARTNER_THREAD_ID, quietPartnerTurn);
        }
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-partner-turn-start"),
          threadId: PARTNER_THREAD_ID,
          message: {
            messageId: MessageId.make("msg-partner-user"),
            role: "user",
            text: "Commit and push.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: CREATED_AT,
        });
        yield* harness.waitForThread(
          PARTNER_THREAD_ID,
          (thread) => thread.latestTurn?.state === "completed",
        );

        const taskOf = (taskId: string): Effect.Effect<DeveloperTask> =>
          supervisor
            .check(taskId as DeveloperTask["taskId"])
            .pipe(Effect.map(Option.getOrThrow), Effect.orDie);
        const responsesOf = (taskId: string) =>
          adapter
            .getApprovalResponses(workThreadIdOf(taskId))
            .map((response) => [response.requestId as string, response.decision] as const);
        const startTask = (goal: string) =>
          callTool("start_developer_task", { goal, acceptance: "done", scope: "small" });

        // Push #1 asks; the card offers exactly the push part.
        const gate1 = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "chain-1",
            requests: [{ requestId: "req-chain-1", command: chainedPush("first change") }],
            gate: gate1,
          }),
        );
        const first = yield* startTask("Commit and push");
        yield* harness.waitForDomainEvent(isTaskState(first.taskId, "waiting-on-bot"));
        assert.deepEqual((yield* taskOf(first.taskId)).pendingRequest?.alwaysAllow, [
          { approvalClass: "production", matchDetail: "git push origin master" },
        ]);
        const { cardId } = yield* callTool("ask_user", {
          kind: "approval",
          question: "The developer wants to commit and push to origin/master. OK?",
          taskId: first.taskId,
          requestId: "req-chain-1",
        });
        const card = (yield* readEvents(harness)).flatMap((event) =>
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === PARTNER_DECISION_ACTIVITY_KIND
            ? [event.payload.activity.payload as { alwaysAllow?: unknown }]
            : [],
        )[0];
        assert.deepEqual(card?.alwaysAllow, [
          { approvalClass: "production", matchDetail: "git push origin master" },
        ]);

        yield* decisions.resolve({
          cardId,
          parentThreadId: PARTNER_THREAD_ID,
          decision: "always_allow",
        });
        const stored = yield* rules.list();
        assert.deepEqual(
          stored.map((rule) => [rule.approvalClass, rule.matchDetail]),
          [["production", "git push origin master"]],
        );
        yield* waitForSync(
          () => responsesOf(first.taskId),
          (responses) => responses.length === 1,
          "push #1 to be accepted",
        );
        yield* Deferred.succeed(gate1, undefined);
        yield* harness.waitForDomainEvent(isTaskState(first.taskId, "completed"));

        // Push #2, with a different commit message, is accepted with no card.
        const gate2 = yield* Deferred.make<void>();
        yield* adapter.queueTurnResponseForNextSession(
          developerTurn({
            tag: "chain-2",
            requests: [{ requestId: "req-chain-2", command: chainedPush("second change") }],
            gate: gate2,
          }),
        );
        const second = yield* startTask("Commit and push again");
        yield* waitForSync(
          () => responsesOf(second.taskId),
          (responses) => responses.length === 1,
          "push #2 to be accepted",
        );
        assert.deepEqual(responsesOf(second.taskId), [["req-chain-2", "accept"]]);
        const after = yield* readEvents(harness);
        assert.isFalse(after.some(isTaskState(second.taskId, "waiting-on-bot")));
        assert.deepEqual(decisionCardIds(after), [cardId], "no new card was drawn");
        yield* Deferred.succeed(gate2, undefined);
        yield* harness.waitForDomainEvent(isTaskState(second.taskId, "completed"));
      }),
    ),
  90_000,
);
