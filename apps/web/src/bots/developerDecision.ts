import {
  type ApprovalClass,
  type OrchestrationThreadActivity,
  PARTNER_DECISION_ACTIVITY_KIND,
  PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
  type PartnerDecisionKind,
} from "@t3tools/contracts";

/**
 * One command part Always allow will remember. `kind` flags parts whose real action the
 * user can't read off the policy: code run on another machine, or inline code.
 */
export interface AlwaysAllowKey {
  readonly key: string;
  readonly kind: "remote" | "inline" | null;
}

const REMOTE_COMMAND = /(^|\s)(ssh|scp|rsync)\s/;

export function alwaysAllowKeyOf(matchDetail: string, approvalClass: unknown): AlwaysAllowKey {
  const kind =
    approvalClass === "opaque" ? "inline" : REMOTE_COMMAND.test(matchDetail) ? "remote" : null;
  return { key: matchDetail, kind };
}

/** A question or approval the partner put to the user with `ask_user`, as the card shows it. */
export interface PartnerDecisionCardModel {
  readonly cardId: string;
  readonly kind: PartnerDecisionKind;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  /** Present when the request is classified; only then can it be always allowed. */
  readonly approvalClass: ApprovalClass | null;
  /** The normalized command parts Always allow will remember, e.g. `git push origin main`. */
  readonly alwaysAllow: ReadonlyArray<AlwaysAllowKey>;
  readonly createdAt: string;
}

const APPROVAL_CLASSES: ReadonlySet<string> = new Set([
  "none",
  "install",
  "delete",
  "outside-workspace",
  "send",
  "production",
  "secrets",
  "opaque",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Cards the partner raised with a `partner-decision` activity and the user has not answered.
 * Every answer appends `partner-decision.resolved`, so the card goes away.
 */
export function derivePendingPartnerDecisions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PartnerDecisionCardModel> {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== PARTNER_DECISION_RESOLVED_ACTIVITY_KIND) continue;
    const cardId = record(activity.payload)?.cardId;
    if (typeof cardId === "string") resolved.add(cardId);
  }
  const cards: PartnerDecisionCardModel[] = [];
  for (const activity of activities) {
    if (activity.kind !== PARTNER_DECISION_ACTIVITY_KIND) continue;
    const payload = record(activity.payload);
    const cardId = payload?.cardId;
    const question = payload?.question;
    const kind = payload?.kind;
    if (
      typeof cardId !== "string" ||
      typeof question !== "string" ||
      (kind !== "question" && kind !== "approval") ||
      resolved.has(cardId)
    ) {
      continue;
    }
    const options = Array.isArray(payload?.options)
      ? payload.options.filter((option): option is string => typeof option === "string")
      : [];
    const approvalClass = payload?.approvalClass;
    const alwaysAllow = Array.isArray(payload?.alwaysAllow)
      ? payload.alwaysAllow.flatMap((entry) => {
          const matchDetail = record(entry)?.matchDetail;
          return typeof matchDetail === "string" && matchDetail.length > 0
            ? [alwaysAllowKeyOf(matchDetail, record(entry)?.approvalClass)]
            : [];
        })
      : [];
    cards.push({
      cardId,
      kind,
      question,
      options,
      approvalClass:
        typeof approvalClass === "string" && APPROVAL_CLASSES.has(approvalClass)
          ? (approvalClass as ApprovalClass)
          : null,
      alwaysAllow,
      createdAt: activity.createdAt,
    });
  }
  return cards;
}
