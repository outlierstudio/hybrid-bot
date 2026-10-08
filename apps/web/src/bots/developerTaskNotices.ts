import type { DeveloperTask, DeveloperTaskState } from "@t3tools/contracts";

/** A developer task that just ended in a way the user should hear about while away. */
export interface DeveloperTaskNotice {
  readonly taskId: string;
  readonly kind: "completed" | "failed";
  readonly goal: string;
}

/** Task id → last seen state. `null` until the first snapshot has been read. */
export type DeveloperTaskStateBaseline = ReadonlyMap<string, DeveloperTaskState> | null;

export function baselineOf(
  tasks: ReadonlyArray<DeveloperTask>,
): ReadonlyMap<string, DeveloperTaskState> {
  return new Map(tasks.map((task) => [task.taskId, task.state]));
}

/**
 * Compares the projected tasks with what was last seen. The first snapshot (and any task that
 * was not in the previous one) only seeds the baseline: opening a thread, or reconnecting, must
 * not replay old results as fresh alerts. Only a task seen working that has since completed or
 * failed is a notice; a canceled task is the user's own doing and stays quiet.
 */
export function diffDeveloperTaskNotices(
  baseline: DeveloperTaskStateBaseline,
  tasks: ReadonlyArray<DeveloperTask>,
): {
  readonly baseline: ReadonlyMap<string, DeveloperTaskState>;
  readonly notices: ReadonlyArray<DeveloperTaskNotice>;
} {
  const next = baselineOf(tasks);
  if (baseline === null) return { baseline: next, notices: [] };
  const notices: DeveloperTaskNotice[] = [];
  for (const task of tasks) {
    const before = baseline.get(task.taskId);
    if (before === undefined || before === task.state) continue;
    if (task.state === "completed" || task.state === "failed") {
      notices.push({ taskId: task.taskId, kind: task.state, goal: task.brief.goal });
    }
  }
  return { baseline: next, notices };
}
