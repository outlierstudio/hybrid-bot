/**
 * HYBRID: partner decision cards (AUDIT §5.7, §5.10).
 *
 * The partner escalates a question or an approval to the user with `ask_user`. The server
 * records the card as a `partner-decision` activity on the partner's chat thread; the
 * user's answer is a `partner-decision.resolved` activity. Clients only send the resolve.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BotId } from "./bots.ts";
import { AlwaysAllowEntry, ApprovalClass, DeveloperTaskId } from "./developerTask.ts";

export const PartnerDecisionCardId = TrimmedNonEmptyString.pipe(
  Schema.brand("PartnerDecisionCardId"),
);
export type PartnerDecisionCardId = typeof PartnerDecisionCardId.Type;

export const PartnerDecisionKind = Schema.Literals(["question", "approval"]);
export type PartnerDecisionKind = typeof PartnerDecisionKind.Type;

/** `answer` is how a resolved question is recorded; the client sends `accept` with the text. */
export const PartnerDecisionResolveDecision = Schema.Literals([
  "accept",
  "decline",
  "always_allow",
  "answer",
]);
export type PartnerDecisionResolveDecision = typeof PartnerDecisionResolveDecision.Type;

export const PartnerDecisionCard = Schema.Struct({
  cardId: PartnerDecisionCardId,
  parentThreadId: ThreadId,
  botId: BotId,
  kind: PartnerDecisionKind,
  question: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  taskId: Schema.optional(DeveloperTaskId),
  requestId: Schema.optional(TrimmedNonEmptyString),
  approvalClass: Schema.optional(ApprovalClass),
  /** Raw command/path for Always-allow structured rules. */
  matchDetail: Schema.optional(Schema.String),
  /** Exactly what Always allow will remember; the card's label shows these. */
  alwaysAllow: Schema.optional(Schema.Array(AlwaysAllowEntry)),
  createdAt: IsoDateTime,
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type PartnerDecisionCard = typeof PartnerDecisionCard.Type;

export const PARTNER_DECISION_ACTIVITY_KIND = "partner-decision";
export const PARTNER_DECISION_RESOLVED_ACTIVITY_KIND = "partner-decision.resolved";

/** The user's answer to a card. Questions send `accept` with `answerText` or `selectedOption`. */
export const PartnerDecisionResolveInput = Schema.Struct({
  cardId: PartnerDecisionCardId,
  /** The card's thread; the server reads the card back from it. */
  parentThreadId: ThreadId,
  decision: Schema.Literals(["accept", "decline", "always_allow"]),
  answerText: Schema.optional(Schema.String),
  selectedOption: Schema.optional(Schema.String),
});
export type PartnerDecisionResolveInput = typeof PartnerDecisionResolveInput.Type;

export const PartnerDecisionError = Schema.Struct({
  code: Schema.Literals(["rejected", "failed"]),
  message: TrimmedNonEmptyString,
});
export type PartnerDecisionError = typeof PartnerDecisionError.Type;
