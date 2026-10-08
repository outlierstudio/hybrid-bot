import {
  BotId,
  DeveloperTaskId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DeveloperTask,
  type DeveloperTaskListStreamEvent,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
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

const PARENT = ThreadId.make("parent-a");
const OTHER_PARENT = ThreadId.make("parent-b");
const NOW = "2026-08-01T00:00:00.000Z";

const task = (taskId: string, parentThreadId: ThreadId, state: DeveloperTask["state"]) =>
  ({
    taskId: DeveloperTaskId.make(taskId),
    parentThreadId,
    parentTurnId: TurnId.make("turn-1"),
    workThreadId: null,
    workTurnIds: [],
    botId: BotId.make("bot-1"),
    brief: {
      goal: "Fix the login redirect",
      context: "",
      constraints: "",
      acceptance: "",
      scope: "small",
    },
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    state,
    pendingRequest: null,
    result: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
  }) satisfies DeveloperTask;

const created = (value: DeveloperTask) =>
  ({
    type: "developer-task.created",
    aggregateKind: "developerTask",
    payload: { task: value },
  }) as unknown as OrchestrationEvent;

const stateSet = (taskId: string, state: DeveloperTask["state"]) =>
  ({
    type: "developer-task.state-set",
    aggregateKind: "developerTask",
    payload: { taskId, state, updatedAt: NOW },
  }) as unknown as OrchestrationEvent;

const policyLayer = PolicyEngine.layer.pipe(
  Layer.provide(Layer.mock(PolicyRulesStore)({ listApplicable: () => Effect.succeed([]) })),
);

const makeHarness = Effect.fn("makeWatchHarness")(function* (
  existing: ReadonlyArray<DeveloperTask>,
) {
  const table = new Map<string, DeveloperTask>(existing.map((entry) => [entry.taskId, entry]));
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    }),
    Layer.mock(ProjectionDeveloperTaskRepository)({
      listByParentThreadId: ({ parentThreadId }) =>
        Effect.succeed(
          [...table.values()].filter((entry) => entry.parentThreadId === parentThreadId),
        ),
      getById: ({ taskId }) => Effect.succeed(Option.fromNullishOr(table.get(taskId))),
    }),
    Layer.mock(ProjectionSnapshotQuery)({}),
    Layer.mock(ProviderService)({}),
    Layer.mock(BotRegistry.BotRegistry)({}),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
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
  return {
    supervisor,
    table,
    publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
  };
});

describe("DelegationSupervisor.watch", () => {
  it.effect("opens with the parent thread's tasks, then streams each change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness([
          task("t-mine", PARENT, "running"),
          task("t-theirs", OTHER_PARENT, "running"),
        ]);
        const stream = yield* harness.supervisor.watch(PARENT);

        // Live delivery is attached before the first read, so these are not lost.
        const newTask = task("t-new", PARENT, "queued");
        harness.table.set(newTask.taskId, newTask);
        yield* harness.publish(created(newTask));
        yield* harness.publish(created(task("t-other-new", OTHER_PARENT, "queued")));
        harness.table.set("t-mine", { ...task("t-mine", PARENT, "completed") });
        yield* harness.publish(stateSet("t-theirs", "completed"));
        yield* harness.publish(stateSet("t-mine", "completed"));

        const seen: Array<DeveloperTaskListStreamEvent> = Array.from(
          yield* stream.pipe(Stream.take(3), Stream.runCollect),
        );
        const [snapshot, createdEvent, changed] = seen;
        assert.equal(snapshot?._tag, "snapshot");
        assert.deepEqual(
          snapshot?._tag === "snapshot" ? snapshot.tasks.map((entry) => entry.taskId) : [],
          ["t-mine"],
        );
        assert.equal(createdEvent?._tag === "upserted" ? createdEvent.task.taskId : null, "t-new");
        assert.equal(changed?._tag === "upserted" ? changed.task.taskId : null, "t-mine");
        assert.equal(changed?._tag === "upserted" ? changed.task.state : null, "completed");
      }),
    ),
  );
});
