/**
 * // HYBRID: the developer-task projection and its live beats for one parent thread.
 *
 * Two server streams, both read-scoped: the task records (`developerTask.subscribeTasks`) and
 * the ephemeral per-task beat (`developerTask.subscribeStatus`). Each folds into one value,
 * so the work cards render from state the server owns rather than from message text.
 */
import {
  WS_METHODS,
  type DeveloperTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";
import {
  deriveDeveloperWorkCards,
  EMPTY_DEVELOPER_TASKS,
  EMPTY_DEVELOPER_WORK_LIVE_STATUSES,
  reduceDeveloperTaskList,
  reduceDeveloperWorkLiveStatuses,
  type DeveloperWorkLiveStatuses,
} from "./developerWork";

const developerTasksSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "hybrid:developer-task:tasks",
    tag: WS_METHODS.subscribeDeveloperTasks,
    // Dropped with the thread view; a reopened thread starts from a fresh snapshot.
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(EMPTY_DEVELOPER_TASKS as ReadonlyArray<DeveloperTask>, reduceDeveloperTaskList),
      ),
  },
);

const developerTaskStatusSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "hybrid:developer-task:status",
    tag: WS_METHODS.subscribeDeveloperTaskStatus,
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(
          EMPTY_DEVELOPER_WORK_LIVE_STATUSES as DeveloperWorkLiveStatuses,
          reduceDeveloperWorkLiveStatuses,
        ),
      ),
  },
);

/** The work card's Stop. The server interrupts the work thread and cancels the task. */
export const stopDeveloperTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:stop-developer-task",
  tag: WS_METHODS.botsStopDeveloperTask,
});

/**
 * The raw task records for one partner thread, or `null` until the first snapshot arrives.
 * Shares the work cards' subscription, so watching a thread twice opens one stream.
 */
export function useDeveloperTaskList(target: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly enabled: boolean;
}): ReadonlyArray<DeveloperTask> | null {
  const { environmentId, parentThreadId, enabled } = target;
  const tasksQuery = useEnvironmentQuery(
    enabled ? developerTasksSubscription({ environmentId, input: { parentThreadId } }) : null,
  );
  return tasksQuery.data;
}

export function useDeveloperWorkCards(target: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  /** Off for threads that cannot have delegated work, so they open no stream. */
  readonly enabled: boolean;
}) {
  const { environmentId, parentThreadId, enabled } = target;
  const tasksQuery = useEnvironmentQuery(
    enabled ? developerTasksSubscription({ environmentId, input: { parentThreadId } }) : null,
  );
  const statusQuery = useEnvironmentQuery(
    enabled ? developerTaskStatusSubscription({ environmentId, input: { parentThreadId } }) : null,
  );
  const tasks = tasksQuery.data ?? EMPTY_DEVELOPER_TASKS;
  const statuses = statusQuery.data ?? EMPTY_DEVELOPER_WORK_LIVE_STATUSES;
  return useMemo(() => deriveDeveloperWorkCards(tasks, statuses), [tasks, statuses]);
}
