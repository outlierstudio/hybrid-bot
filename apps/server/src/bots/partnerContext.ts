/**
 * HYBRID: the per-turn `<partner_context>` block (AUDIT F5).
 *
 * Rebuilt every partner turn (wake-ups included) and prepended to the turn input, never to
 * the session prompt, so the partner sees the project as it is now. Pure; the inputs are
 * facts the server already has. It never carries file contents or environment values: only
 * the branch name, a count of uncommitted files, and developer task goals and states.
 * AGENTS.md / CLAUDE.md stay out: the provider CLIs already load them.
 */
import type { DeveloperTaskState } from "@t3tools/contracts";

export const PARTNER_CONTEXT_MAX_CHARS = 1500;
const MAX_TASKS = 5;
const MAX_RECENT_FINISHED = 3;
const MAX_GOAL_CHARS = 120;

export interface PartnerContextTask {
  readonly taskId: string;
  readonly goal: string;
  readonly state: DeveloperTaskState;
}

export interface PartnerContextInput {
  readonly branch: string | null;
  /** Count only; file names and contents never go in. */
  readonly uncommittedFiles: number | null;
  /** The thread's developer tasks, oldest first. */
  readonly tasks: ReadonlyArray<PartnerContextTask>;
}

const FINISHED: ReadonlySet<DeveloperTaskState> = new Set(["completed", "failed", "canceled"]);

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Running work first, then the most recent finished tasks. */
function selectTasks(tasks: ReadonlyArray<PartnerContextTask>): ReadonlyArray<PartnerContextTask> {
  const open = tasks.filter((task) => !FINISHED.has(task.state));
  const finished = tasks.filter((task) => FINISHED.has(task.state)).slice(-MAX_RECENT_FINISHED);
  return [...open, ...finished].slice(0, MAX_TASKS);
}

const wrap = (lines: ReadonlyArray<string>) =>
  ["<partner_context>", ...lines, "</partner_context>"].join("\n");

/** `null` when there is nothing worth saying. Never longer than {@link PARTNER_CONTEXT_MAX_CHARS}. */
export function buildPartnerContext(input: PartnerContextInput): string | null {
  const head: string[] = [];
  if (input.branch !== null && input.branch.trim().length > 0) {
    head.push(`branch: ${truncate(oneLine(input.branch), 100)}`);
  }
  if (input.uncommittedFiles !== null) {
    head.push(`uncommitted files: ${input.uncommittedFiles}`);
  }
  let taskLines = selectTasks(input.tasks).map(
    (task) => `- ${task.state}: ${truncate(oneLine(task.goal), MAX_GOAL_CHARS)} (${task.taskId})`,
  );
  const assemble = () =>
    taskLines.length > 0 ? [...head, "developer work:", ...taskLines] : [...head];

  // Drop the oldest listed tasks until it fits.
  let lines = assemble();
  while (wrap(lines).length > PARTNER_CONTEXT_MAX_CHARS && taskLines.length > 0) {
    taskLines = taskLines.slice(0, -1);
    lines = assemble();
  }
  if (lines.length === 0) return null;
  const text = wrap(lines);
  return text.length <= PARTNER_CONTEXT_MAX_CHARS ? text : null;
}
