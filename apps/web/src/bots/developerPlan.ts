import type { DeveloperTaskScope, OrchestrationThreadActivity } from "@t3tools/contracts";

/** A developer task parked on the user's go-ahead, as the plan card shows it. */
export interface DeveloperPlanCardModel {
  readonly taskId: string;
  readonly goal: string;
  /** One short line of the brief's context. Empty when the brief gave none. */
  readonly summary: string;
  readonly scope: DeveloperTaskScope | null;
  readonly createdAt: string;
}

export const DEVELOPER_PLAN_ACTIVITY_KIND = "developer-task.plan";
export const DEVELOPER_PLAN_RESOLVED_ACTIVITY_KIND = "developer-task.plan.resolved";

const SUMMARY_LIMIT = 160;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** First line of the context, whitespace collapsed and clipped. */
export function summarizePlanContext(context: string): string {
  const line = context
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  if (line === undefined) return "";
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : line;
}

/**
 * Plans the server parked with a `developer-task.plan` activity and has not resolved since.
 * Confirm, decline, and stop each append `developer-task.plan.resolved`, so the card goes away.
 */
export function derivePendingDeveloperPlans(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<DeveloperPlanCardModel> {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== DEVELOPER_PLAN_RESOLVED_ACTIVITY_KIND) continue;
    const taskId = record(activity.payload)?.taskId;
    if (typeof taskId === "string") resolved.add(taskId);
  }
  const plans: DeveloperPlanCardModel[] = [];
  for (const activity of activities) {
    if (activity.kind !== DEVELOPER_PLAN_ACTIVITY_KIND) continue;
    const payload = record(activity.payload);
    const taskId = payload?.taskId;
    const goal = payload?.goal;
    if (typeof taskId !== "string" || typeof goal !== "string" || resolved.has(taskId)) continue;
    const scope = payload?.scope;
    plans.push({
      taskId,
      goal,
      summary: summarizePlanContext(typeof payload?.context === "string" ? payload.context : ""),
      scope: scope === "small" || scope === "medium" || scope === "large" ? scope : null,
      createdAt: activity.createdAt,
    });
  }
  return plans;
}
