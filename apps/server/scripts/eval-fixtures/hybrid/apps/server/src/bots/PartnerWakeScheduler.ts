/** Decides when to wake the partner: on task milestones (failed, completed, approval). */
export function shouldWake(kind: "failed" | "completed" | "approval"): boolean {
  return kind === "failed" || kind === "completed" || kind === "approval";
}
