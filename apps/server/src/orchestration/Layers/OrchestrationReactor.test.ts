import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as PartnerApprovalBackstop from "../../bots/PartnerApprovalBackstop.ts";
import * as DelegationSupervisor from "../../bots/DelegationSupervisor.ts";
import * as PartnerWakeScheduler from "../../bots/PartnerWakeScheduler.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { StorageCleanup } from "../../storageCleanup.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts every orchestration reactor", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(StorageCleanup, {
            start: () => {
              started.push("storage-cleanup");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(PartnerApprovalBackstop.PartnerApprovalBackstop, {
            start: () => {
              started.push("partner-approval-backstop");
              return Effect.void;
            },
            handleActivity: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.mock(DelegationSupervisor.DelegationSupervisor)({
            startReactor: () => {
              started.push("delegation-supervisor");
              return Effect.void;
            },
          }),
        ),
        Layer.provideMerge(
          Layer.mock(PartnerWakeScheduler.PartnerWakeScheduler)({
            notify: () => Effect.void,
            takePendingPreamble: () => Effect.succeed(null),
            onPartnerTurnSettled: () => Effect.void,
            startReactor: () => {
              started.push("partner-wake-scheduler");
              return Effect.void;
            },
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drainThrough: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadPullRequestReactor.ThreadPullRequestReactor, {
            start: () => {
              started.push("thread-pull-request-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadSettlementReactor.ThreadSettlementReactor, {
            start: () => {
              started.push("thread-settlement-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(PullRequestSyncReactor.PullRequestSyncReactor, {
            start: () => {
              started.push("pull-request-sync-reactor");
              return Effect.void;
            },
            drain: Effect.void,
            requestSync: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "partner-approval-backstop",
      "delegation-supervisor",
      "partner-wake-scheduler",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "thread-pull-request-reactor",
      "thread-settlement-reactor",
      "pull-request-sync-reactor",
      "agent-awareness-relay",
      "storage-cleanup",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
