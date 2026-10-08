import type { DeveloperTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffDeveloperTaskNotices } from "./developerTaskNotices";

const task = (taskId: string, state: DeveloperTask["state"]) =>
  ({ taskId, state, brief: { goal: `Goal ${taskId}` } }) as unknown as DeveloperTask;

describe("diffDeveloperTaskNotices", () => {
  it("only seeds the baseline on the first snapshot", () => {
    const first = diffDeveloperTaskNotices(null, [task("a", "completed"), task("b", "failed")]);
    expect(first.notices).toEqual([]);
    expect(first.baseline.get("a")).toBe("completed");
  });

  it("reports a task that finished since it was last seen", () => {
    const seeded = diffDeveloperTaskNotices(null, [task("a", "running"), task("b", "running")]);
    const next = diffDeveloperTaskNotices(seeded.baseline, [
      task("a", "completed"),
      task("b", "failed"),
    ]);
    expect(next.notices).toEqual([
      { taskId: "a", kind: "completed", goal: "Goal a" },
      { taskId: "b", kind: "failed", goal: "Goal b" },
    ]);
    // Seen once; the same state again is quiet.
    expect(diffDeveloperTaskNotices(next.baseline, [task("a", "completed")]).notices).toEqual([]);
  });

  it("stays quiet for canceled, waiting, and unseen tasks", () => {
    const seeded = diffDeveloperTaskNotices(null, [task("a", "running")]);
    const next = diffDeveloperTaskNotices(seeded.baseline, [
      task("a", "canceled"),
      task("new", "completed"),
    ]);
    expect(next.notices).toEqual([]);
    expect(
      diffDeveloperTaskNotices(seeded.baseline, [task("a", "waiting-on-user")]).notices,
    ).toEqual([]);
  });
});
