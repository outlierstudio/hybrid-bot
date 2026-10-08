/**
 * // HYBRID: pure developer-task reducers shared by the in-memory projector and the
 * SQL projection pipeline so both stay in lockstep.
 */
import type {
  DeveloperTask,
  DeveloperTaskStateSetPayload,
  DeveloperTaskSteeredPayload,
} from "@t3tools/contracts";

export function isTerminalDeveloperTaskState(state: DeveloperTask["state"]): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

/** Apply a `developer-task.state-set` payload: only fields the event carries change. */
export function applyDeveloperTaskStateSet(
  task: DeveloperTask,
  payload: DeveloperTaskStateSetPayload,
): DeveloperTask {
  return {
    ...task,
    state: payload.state,
    ...(payload.workThreadId !== undefined ? { workThreadId: payload.workThreadId } : {}),
    ...(payload.pendingRequest !== undefined ? { pendingRequest: payload.pendingRequest } : {}),
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.failure !== undefined ? { failure: payload.failure } : {}),
    ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
    ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
    updatedAt: payload.updatedAt,
  };
}

/** Apply a `developer-task.steered` payload: the steer turn joins the work turns. */
export function applyDeveloperTaskSteered(
  task: DeveloperTask,
  payload: DeveloperTaskSteeredPayload,
): DeveloperTask {
  return {
    ...task,
    workTurnIds: task.workTurnIds.includes(payload.turnId)
      ? task.workTurnIds
      : [...task.workTurnIds, payload.turnId],
    updatedAt: payload.updatedAt,
  };
}
