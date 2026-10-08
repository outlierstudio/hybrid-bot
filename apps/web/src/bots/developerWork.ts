import type {
  DeveloperTask,
  DeveloperTaskListStreamEvent,
  DeveloperTaskState,
  DeveloperTaskStatusStreamEvent,
  ThreadId,
} from "@t3tools/contracts";

/**
 * A developer task as the work card shows it. Built from the task projection, never from
 * message text, so the card is right after a reload and on every client.
 */
type DeveloperTaskCheck = NonNullable<DeveloperTask["result"]>["checks"][number];

export interface DeveloperWorkCardModel {
  readonly taskId: string;
  readonly goal: string;
  readonly state: Exclude<DeveloperTaskState, "awaiting-confirmation">;
  readonly workThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** The present-tense beat, only while the task is live. */
  readonly liveStatus: string | null;
  /** The ask the developer is blocked on, while one is open. */
  readonly pendingSummary: string | null;
  /** Why it stopped, for a failed task. */
  readonly failureMessage: string | null;
  /** The developer's closing summary, for a finished task. */
  readonly resultSummary: string | null;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly additions: number;
  readonly deletions: number;
  readonly checks: ReadonlyArray<DeveloperTaskCheck>;
  /** The source task, so rows can tell an unchanged card from a changed one by identity. */
  readonly task: DeveloperTask;
}

export type DeveloperWorkLiveStatuses = Readonly<Record<string, string | null>>;

export const EMPTY_DEVELOPER_TASKS: ReadonlyArray<DeveloperTask> = [];
export const EMPTY_DEVELOPER_WORK_LIVE_STATUSES: DeveloperWorkLiveStatuses = {};

export function isDeveloperTaskLive(state: DeveloperTaskState): boolean {
  return state !== "completed" && state !== "failed" && state !== "canceled";
}

/** Live work the user can still stop. */
export function canStopDeveloperTask(state: DeveloperTaskState): boolean {
  return isDeveloperTaskLive(state);
}

/** Tasks the work card draws. The plan card owns `awaiting-confirmation`. */
function showsWorkCard(task: DeveloperTask): boolean {
  if (task.state === "awaiting-confirmation") return false;
  // A plan the user declined never started; it leaves no card behind.
  if (task.state === "canceled" && task.workThreadId === null && task.startedAt === null) {
    return false;
  }
  return true;
}

export function deriveDeveloperWorkCards(
  tasks: ReadonlyArray<DeveloperTask>,
  liveStatuses: DeveloperWorkLiveStatuses = EMPTY_DEVELOPER_WORK_LIVE_STATUSES,
): ReadonlyArray<DeveloperWorkCardModel> {
  const cards: DeveloperWorkCardModel[] = [];
  for (const task of tasks) {
    if (!showsWorkCard(task)) continue;
    const state = task.state as DeveloperWorkCardModel["state"];
    const files = task.result?.filesChanged ?? [];
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    const summary = task.result?.summary.trim() ?? "";
    cards.push({
      taskId: task.taskId,
      goal: task.brief.goal,
      state,
      workThreadId: task.workThreadId,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      liveStatus: isDeveloperTaskLive(state) ? (liveStatuses[task.taskId] ?? null) : null,
      pendingSummary:
        isDeveloperTaskLive(state) && task.pendingRequest !== null
          ? task.pendingRequest.summary
          : null,
      failureMessage: state === "failed" ? (task.failure?.message ?? null) : null,
      resultSummary: summary.length > 0 ? summary : null,
      files,
      additions,
      deletions,
      checks: task.result?.checks ?? [],
      task,
    });
  }
  return cards;
}

/** Same card, same task record and beat: the timeline can keep the row it has. */
export function developerWorkCardsEqual(
  a: DeveloperWorkCardModel,
  b: DeveloperWorkCardModel,
): boolean {
  return a.task === b.task && a.liveStatus === b.liveStatus;
}

export const DEVELOPER_TASK_STATE_LABEL: Record<DeveloperWorkCardModel["state"], string> = {
  queued: "Queued",
  running: "Working",
  "waiting-on-bot": "Checking in",
  "waiting-on-user": "Needs your OK",
  completed: "Done",
  failed: "Failed",
  canceled: "Stopped",
};

/** "45s", "3m 12s", "1h 04m". */
export function formatDeveloperTaskElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Time spent working: from start to now while live, from start to finish once done.
 * A queued task has not started, so it shows none.
 */
export function developerWorkElapsedMs(
  card: Pick<DeveloperWorkCardModel, "state" | "startedAt" | "completedAt">,
  nowMs: number,
): number | null {
  if (card.startedAt === null) return null;
  const startedMs = Date.parse(card.startedAt);
  if (Number.isNaN(startedMs)) return null;
  if (isDeveloperTaskLive(card.state)) return Math.max(0, nowMs - startedMs);
  if (card.completedAt === null) return null;
  const completedMs = Date.parse(card.completedAt);
  return Number.isNaN(completedMs) ? null : Math.max(0, completedMs - startedMs);
}

/** Folds one task-list stream event into the list. Unchanged tasks keep their identity. */
export function reduceDeveloperTaskList(
  tasks: ReadonlyArray<DeveloperTask>,
  event: DeveloperTaskListStreamEvent,
): ReadonlyArray<DeveloperTask> {
  if (event._tag === "snapshot") return event.tasks;
  const index = tasks.findIndex((task) => task.taskId === event.task.taskId);
  if (index === -1) return [...tasks, event.task];
  return tasks.map((task, i) => (i === index ? event.task : task));
}

/** Folds one liveStatus stream event into the beat map. A cleared task drops out. */
export function reduceDeveloperWorkLiveStatuses(
  statuses: DeveloperWorkLiveStatuses,
  event: DeveloperTaskStatusStreamEvent,
): DeveloperWorkLiveStatuses {
  if (event._tag === "snapshot") {
    const next: Record<string, string | null> = {};
    for (const status of event.statuses) next[status.taskId] = status.liveStatus;
    return next;
  }
  const { taskId, liveStatus } = event.status;
  if (liveStatus === null) {
    if (!(taskId in statuses)) return statuses;
    const { [taskId]: _removed, ...rest } = statuses;
    return rest;
  }
  return statuses[taskId] === liveStatus ? statuses : { ...statuses, [taskId]: liveStatus };
}
