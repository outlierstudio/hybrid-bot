/**
 * // HYBRID: the one-line presence for a partner thread's top bar and the sidebar row state.
 *
 * Pure, so the top bar, the face, and the sidebar agree on one source: developer-task state
 * and live status from the server, plus whether a decision or plan card is open.
 */
import { HYBRID_DEVELOPER_DIRECT, type OrchestrationThreadShell } from "@t3tools/contracts";

import type { DeveloperWorkCardModel } from "./developerWork";

export type PartnerPresenceKind = "working" | "waiting" | "ready";

export interface PartnerPresence {
  readonly kind: PartnerPresenceKind;
  readonly text: string;
}

const LIVE_STATES = new Set(["queued", "running", "waiting-on-bot", "waiting-on-user"]);

/** "Waiting for you" beats a live beat; a live beat beats "Ready". */
export function derivePartnerPresence(input: {
  readonly work: ReadonlyArray<Pick<DeveloperWorkCardModel, "state" | "liveStatus">>;
  readonly openDecisionCards: number;
  readonly openPlanCards: number;
}): PartnerPresence {
  const live = input.work.filter((card) => LIVE_STATES.has(card.state));
  if (
    input.openDecisionCards > 0 ||
    input.openPlanCards > 0 ||
    live.some((card) => card.state === "waiting-on-user")
  ) {
    return { kind: "waiting", text: "Waiting for you" };
  }
  // The newest live task speaks for the thread.
  const active = live.at(-1);
  if (active !== undefined) {
    const beat = active.liveStatus?.trim();
    return { kind: "working", text: beat && beat.length > 0 ? beat : "Working" };
  }
  return { kind: "ready", text: "Ready" };
}

export type ThreadRowState = "needs-you" | "working" | "done-unread";

/**
 * The sidebar dot for a thread. Pending approvals and inputs (any thread) and a partner
 * task waiting on the user read as "needs you"; live work as "working"; a finished turn the
 * user hasn't opened as "done-unread".
 */
export function resolveThreadRowState(
  thread: Pick<
    OrchestrationThreadShell,
    "partnerState" | "hasPendingApprovals" | "hasPendingUserInput" | "session"
  >,
  hasUnseenCompletion: boolean,
): ThreadRowState | null {
  if (
    thread.partnerState === "needs-user" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  ) {
    return "needs-you";
  }
  if (
    thread.partnerState === "working" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting"
  ) {
    return "working";
  }
  return hasUnseenCompletion ? "done-unread" : null;
}

/** Stable: "needs you" threads move to the top, everything else keeps its order. */
export function needsYouFirst<T>(
  threads: ReadonlyArray<T>,
  stateOf: (thread: T) => ThreadRowState | null,
): ReadonlyArray<T> {
  const needsYou: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) (stateOf(thread) === "needs-you" ? needsYou : rest).push(thread);
  return needsYou.length === 0 ? threads : [...needsYou, ...rest];
}

/**
 * Partner threads fold model, effort, and access into one compact engine control: the
 * partner picks the developer's access itself. Developer directly keeps all three.
 */
export function composerEngineControlMode(
  partnerBotId: string | null | undefined,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): "compact" | "full" {
  // With Developer directly off, every thread talks to Hybrid: always the folded control.
  if (!developerDirect) return "compact";
  return partnerBotId == null ? "full" : "compact";
}
