const DECLINE = /^(no|nope|don't|do not|stop|cancel|nah|leave it)\b/i;
const EXPLICIT_YES = /^(yes|yep|ok|okay|sure|go ahead|do it|approve)\b/i;

/** Hidden partner-owned asks must not freeze the composer queue. */
export function isComposerQueueBlockedByPendingAsk(input: {
  readonly partnerOwnsAsks: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
}): boolean {
  if (input.partnerOwnsAsks) return false;
  return input.hasPendingApproval || input.hasPendingUserInput;
}

/**
 * While a harness ask is pending and the partner owns it, send the reply now
 * instead of parking it behind the running turn.
 */
export function shouldBypassRunningEnqueueForPartnerAsk(input: {
  readonly partnerOwnsAsks: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly phase: string;
}): boolean {
  return (
    input.partnerOwnsAsks &&
    input.phase === "running" &&
    (input.hasPendingApproval || input.hasPendingUserInput)
  );
}

export type PartnerAskReplyDecision = "accept" | "decline" | "ambiguous";

/** Shown when an approval reply is neither an explicit yes nor a decline. */
export const PARTNER_ASK_AMBIGUOUS_HINT = "Reply yes to approve or no to stop this step.";

export function decidePartnerAskReply(reply: string): PartnerAskReplyDecision {
  const text = reply.trim();
  if (DECLINE.test(text)) return "decline";
  if (EXPLICIT_YES.test(text)) return "accept";
  return "ambiguous";
}
