import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import { deriveWorkLogEntries } from "../session-logic";
import { derivePendingDeveloperPlans, summarizePlanContext } from "./developerPlan";

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id,
    kind,
    tone: "info",
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  }) as unknown as OrchestrationThreadActivity;

const plan = (taskId: string, context = "See src/login.ts\nSecond line") =>
  activity(`plan-${taskId}`, "developer-task.plan", {
    taskId,
    goal: "Fix the login redirect",
    context,
    scope: "large",
  });

const resolved = (taskId: string, decision: "confirmed" | "declined" | "edit") =>
  activity(`resolved-${taskId}`, "developer-task.plan.resolved", { taskId, decision });

describe("derivePendingDeveloperPlans", () => {
  it("shows the goal and a one-line context summary", () => {
    expect(derivePendingDeveloperPlans([plan("task-1")])).toEqual([
      {
        taskId: "task-1",
        goal: "Fix the login redirect",
        summary: "See src/login.ts",
        scope: "large",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops a plan once it is confirmed or declined", () => {
    expect(
      derivePendingDeveloperPlans([
        plan("task-1"),
        plan("task-2"),
        plan("task-3"),
        resolved("task-1", "confirmed"),
        resolved("task-2", "declined"),
      ]).map((entry) => entry.taskId),
    ).toEqual(["task-3"]);
  });

  it("drops a plan the user sent back for edits", () => {
    expect(
      derivePendingDeveloperPlans([plan("task-1"), plan("task-2"), resolved("task-1", "edit")]).map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["task-2"]);
  });

  it("ignores malformed plan payloads", () => {
    expect(derivePendingDeveloperPlans([activity("bad", "developer-task.plan", {})])).toEqual([]);
  });

  it("clips a long context line", () => {
    const summary = summarizePlanContext("x".repeat(500));
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarizePlanContext("  \n  ")).toBe("");
  });

  it("keeps plan activities out of the work log", () => {
    expect(deriveWorkLogEntries([plan("task-1"), resolved("task-1", "confirmed")])).toEqual([]);
  });
});

describe("plan card timeline row", () => {
  it("renders one inline row per pending plan", () => {
    const developerPlans = derivePendingDeveloperPlans([plan("task-1")]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      developerPlans,
    });
    expect(rows).toEqual([
      {
        kind: "developer-plan",
        id: "developer-plan:task-1",
        createdAt: "2026-08-01T00:00:00.000Z",
        plan: developerPlans[0],
      },
    ]);
  });
});
