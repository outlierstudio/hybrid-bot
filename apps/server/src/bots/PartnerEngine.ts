/**
 * HYBRID: how a partner talks. Option A runs the partner as a turn on the
 * person's existing provider session, with a read-only profile and the partner
 * persona delivered as session-level instructions (never wrapped around user text).
 */
import type {
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { ProviderServiceError } from "../provider/Errors.ts";

export type PartnerSessionProfile = Pick<
  ProviderSessionStartInput,
  "partnerInstructions" | "partnerReadOnly" | "approvalPolicy" | "sandboxMode"
>;

/** Internal read-only profile. Not a user RuntimeMode. */
export const partnerSessionProfile = (partnerInstructions: string): PartnerSessionProfile => ({
  partnerInstructions,
  partnerReadOnly: true,
  approvalPolicy: "never",
  sandboxMode: "read-only",
});

export interface PartnerStartTurnInput {
  readonly turn: ProviderSendTurnInput;
  /** Start input used when the thread has no live provider session yet. */
  readonly session: ProviderSessionStartInput;
  readonly partnerInstructions: string;
}

export class PartnerEngine extends Context.Service<
  PartnerEngine,
  {
    /** Ensures a partner-profile session exists, then sends the turn unchanged. */
    readonly startTurn: (
      input: PartnerStartTurnInput,
    ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
    readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;
    /** Provider runtime events for one partner thread. */
    readonly events: (threadId: ThreadId) => Stream.Stream<ProviderRuntimeEvent>;
  }
>()("t3/bots/PartnerEngine") {}

const make = Effect.gen(function* () {
  const providers = yield* ProviderService;

  const startTurn: PartnerEngine["Service"]["startTurn"] = Effect.fn("PartnerEngine.startTurn")(
    function* (input) {
      const sessions = yield* providers.listSessions();
      if (!sessions.some((session) => session.threadId === input.turn.threadId)) {
        yield* providers.startSession(input.turn.threadId, {
          ...input.session,
          ...partnerSessionProfile(input.partnerInstructions),
        });
      }
      return yield* providers.sendTurn(input.turn);
    },
  );

  const interrupt: PartnerEngine["Service"]["interrupt"] = (threadId) =>
    providers.interruptTurn({ threadId });

  const events: PartnerEngine["Service"]["events"] = (threadId) =>
    providers.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId));

  return { startTurn, interrupt, events } satisfies PartnerEngine["Service"];
});

export const layer = Layer.effect(PartnerEngine, make);
