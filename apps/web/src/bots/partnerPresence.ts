/**
 * // HYBRID: the one-line presence for a partner thread's top bar and the sidebar row state.
 *
 * Pure, so the top bar, the face, and the sidebar agree on one source: developer-task state
 * and live status from the server, whether a decision or plan card is open, and the
 * partner's own in-progress tool.
 */
import { HYBRID_DEVELOPER_DIRECT, type OrchestrationThreadShell } from "@t3tools/contracts";
import { beatForActivity } from "@t3tools/client-runtime/developer-task/beat-for-activity";

import type { DeveloperWorkCardModel } from "./developerWork";

export type PartnerPresenceKind = "working" | "waiting" | "ready";

export interface PartnerPresence {
  readonly kind: PartnerPresenceKind;
  readonly text: string;
}

const LIVE_STATES = new Set(["queued", "running", "waiting-on-bot", "waiting-on-user"]);

/** Fields `partnerToolBeatFromWorkLog` reads. Matches `WorkLogEntry` without importing it. */
type PartnerToolWorkEntry = {
  readonly turnId?: string | null;
  readonly tone: string;
  readonly toolLifecycleStatus?: string | null;
  readonly itemType?: import("@t3tools/contracts").ToolLifecycleItemType | null;
  readonly toolTitle?: string;
  readonly label: string;
  readonly command?: string;
  readonly rawCommand?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly viewedImagePath?: string;
};

/**
 * Newest in-progress tool on the running turn, as the same present-tense beat developer
 * live status uses. Pass only a turn that is actually running (`activeRunningTurnId`); a
 * finished or missing turn id yields null so an aborted tool cannot stick. Completed and
 * failed tools stay silent.
 */
export function partnerToolBeatFromWorkLog(
  entries: ReadonlyArray<PartnerToolWorkEntry>,
  activeTurnId: string | null,
  workspaceRoot: string | undefined,
): string | null {
  if (activeTurnId == null) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.turnId !== activeTurnId || entry.tone !== "tool") continue;
    if (entry.toolLifecycleStatus !== "inProgress") continue;
    const paths = [
      ...(entry.changedFiles ?? []),
      ...(entry.viewedImagePath ? [entry.viewedImagePath] : []),
    ];
    return beatForActivity(
      {
        kind: "tool",
        title: entry.toolTitle ?? entry.label,
        itemType: entry.itemType,
        command: entry.command ?? entry.rawCommand,
        paths,
        status: "inProgress",
      },
      workspaceRoot,
    );
  }
  return null;
}

/** Waiting for you, then the newest live developer task, then the partner's own tool, then Ready. */
export function derivePartnerPresence(input: {
  readonly work: ReadonlyArray<Pick<DeveloperWorkCardModel, "state" | "liveStatus">>;
  readonly openDecisionCards: number;
  readonly openPlanCards: number;
  readonly partnerToolBeat?: string | null;
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
  const own = input.partnerToolBeat?.trim();
  if (own) return { kind: "working", text: own };
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
