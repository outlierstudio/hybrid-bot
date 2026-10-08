/**
 * HYBRID: the partner's workspace is read-only, so no approval raised on a
 * partner thread (kind "chat" with partnerBotId) should ever reach the user.
 * Providers without a native read-only profile fall back to this: every
 * `approval.requested` on such a thread is declined.
 */
import {
  ApprovalRequestId,
  CommandId,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

export class PartnerApprovalBackstop extends Context.Service<
  PartnerApprovalBackstop,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Declines the approval carried by this event when it is on a partner thread. */
    readonly handleActivity: (
      event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
    ) => Effect.Effect<void>;
  }
>()("t3/bots/PartnerApprovalBackstop") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const declined = new Set<string>();

  const isPartnerThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(
        (thread) =>
          Option.isSome(thread) &&
          (thread.value.kind ?? "chat") === "chat" &&
          typeof thread.value.partnerBotId === "string",
      ),
      Effect.orElseSucceed(() => false),
    );

  const decline = Effect.fn("PartnerApprovalBackstop.decline")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  ) {
    const activity = event.payload.activity;
    if (activity.kind !== "approval.requested") return;
    const payload = activity.payload;
    const requestId =
      payload !== null && typeof payload === "object"
        ? (payload as { requestId?: unknown }).requestId
        : undefined;
    if (typeof requestId !== "string" || requestId.length === 0 || declined.has(requestId)) {
      return;
    }
    if (!(yield* isPartnerThread(event.payload.threadId))) return;
    declined.add(requestId);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.approval.respond",
      commandId: CommandId.make(`server:partner-backstop:${uuid}`),
      threadId: event.payload.threadId,
      requestId: ApprovalRequestId.make(requestId),
      decision: "decline",
      createdAt,
    });
  });

  const handleActivity: PartnerApprovalBackstop["Service"]["handleActivity"] = (event) =>
    decline(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("partner approval backstop failed", {
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: PartnerApprovalBackstop["Service"]["start"] = Effect.fn(
    "PartnerApprovalBackstop.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.activity-appended" ? handleActivity(event) : Effect.void,
      ),
    );
  });

  return { start, handleActivity } satisfies PartnerApprovalBackstop["Service"];
});

export const layer = Layer.effect(PartnerApprovalBackstop, make);
