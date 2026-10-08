/**
 * HYBRID: ephemeral per-task liveStatus beats (AUDIT §5.5).
 *
 * Not stored in the event log. A background flusher publishes at most one update
 * per task per {@link LIVE_STATUS_COALESCE_MS}.
 */
import {
  type DeveloperTaskId,
  type DeveloperTaskLiveStatus,
  type DeveloperTaskStatusStreamEvent,
  type DeveloperTaskStatusSubscribeInput,
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import {
  BEAT_IDLE_THRESHOLD_MS,
  beatForActivity,
  LIVE_STATUS_COALESCE_MS,
  type BeatActivity,
} from "@t3tools/shared/beatForActivity";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const collectPaths = (value: unknown, into: string[], depth: number): void => {
  if (depth > 4 || into.length >= 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectPaths(entry, into, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const path = asString(record[key]);
    if (path && !into.includes(path)) into.push(path);
  }
  for (const nested of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (nested in record) collectPaths(record[nested], into, depth + 1);
  }
};

const extractCommand = (data: Record<string, unknown> | undefined, title: string | undefined) => {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const rawInput = asRecord(data?.rawInput);
  for (const candidate of [
    asString(item?.command),
    asString(itemInput?.command),
    asString(data?.command),
    asString(rawInput?.command),
  ]) {
    if (candidate) return candidate;
  }
  const executable = asString(rawInput?.executable);
  if (executable) {
    const args = Array.isArray(rawInput?.args)
      ? rawInput.args.filter((a): a is string => typeof a === "string").join(" ")
      : "";
    return args.length > 0 ? `${executable} ${args}` : executable;
  }
  if (title) {
    const match = /`([^`]+)`/u.exec(title);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
};

/**
 * Turn a work-thread activity into a beat input, or `null` when the activity is not
 * something the live status cares about (progress heartbeats, resolutions, …).
 */
export function beatActivityFromThreadActivity(
  activity: OrchestrationThreadActivity,
): BeatActivity | null {
  switch (activity.kind) {
    case "approval.requested":
      return { kind: "pending", pending: "approval" };
    case "user-input.requested":
      return { kind: "pending", pending: "question" };
    case "tool.started":
    case "tool.updated": {
      const payload = asRecord(activity.payload) ?? {};
      const itemTypeRaw = asString(payload.itemType);
      const itemType: ToolLifecycleItemType | undefined =
        itemTypeRaw !== undefined && isToolLifecycleItemType(itemTypeRaw) ? itemTypeRaw : undefined;
      const title = asString(payload.title);
      const data = asRecord(payload.data) ?? payload;
      const paths: string[] = [];
      collectPaths(data, paths, 0);
      const command = extractCommand(data, title);
      const statusRaw = asString(payload.status);
      const status =
        statusRaw === "inProgress" ||
        statusRaw === "completed" ||
        statusRaw === "failed" ||
        statusRaw === "declined" ||
        statusRaw === "stopped"
          ? statusRaw
          : activity.kind === "tool.started"
            ? ("inProgress" as const)
            : undefined;
      return {
        kind: "tool",
        ...(itemType !== undefined ? { itemType } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(status !== undefined ? { status } : {}),
      };
    }
    default:
      return null;
  }
}

interface Entry {
  parentThreadId: ThreadId;
  /** Last status published to subscribers. */
  liveStatus: string | null;
  updatedAt: string;
  lastActivityAtMs: number;
  /** Desired status; flushed on the coalesce tick when it differs from liveStatus. */
  pendingStatus: string | null;
  dirty: boolean;
}

export class DeveloperTaskLiveStatusService extends Context.Service<
  DeveloperTaskLiveStatusService,
  {
    /** Record a normalized activity and update the beat. */
    readonly noteActivity: (input: {
      readonly taskId: DeveloperTaskId;
      readonly parentThreadId: ThreadId;
      readonly activity: BeatActivity;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<void>;
    /** Drop the task from the map (terminal state). */
    readonly clear: (taskId: DeveloperTaskId) => Effect.Effect<void>;
    readonly get: (taskId: DeveloperTaskId) => DeveloperTaskLiveStatus | null;
    readonly subscribe: (
      filter: DeveloperTaskStatusSubscribeInput,
    ) => Effect.Effect<Stream.Stream<DeveloperTaskStatusStreamEvent>, never, Scope.Scope>;
    /** Coalesce flusher + idle ticker. Scoped for the server lifetime. */
    readonly startPublisher: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/DeveloperTaskLiveStatus/DeveloperTaskLiveStatusService") {}

const toStatus = (taskId: DeveloperTaskId, entry: Entry): DeveloperTaskLiveStatus => ({
  taskId,
  parentThreadId: entry.parentThreadId,
  liveStatus: entry.liveStatus,
  updatedAt: entry.updatedAt,
});

const matchesFilter = (
  filter: DeveloperTaskStatusSubscribeInput,
  status: DeveloperTaskLiveStatus,
): boolean => {
  if (filter.taskId !== undefined && status.taskId !== filter.taskId) return false;
  if (filter.parentThreadId !== undefined && status.parentThreadId !== filter.parentThreadId) {
    return false;
  }
  return true;
};

export const makeDeveloperTaskLiveStatus = Effect.gen(function* () {
  const entries = new Map<DeveloperTaskId, Entry>();
  const changes = yield* PubSub.unbounded<DeveloperTaskLiveStatus>();

  const ensure = (taskId: DeveloperTaskId, parentThreadId: ThreadId, nowMs: number): Entry => {
    let entry = entries.get(taskId);
    if (!entry) {
      entry = {
        parentThreadId,
        liveStatus: null,
        updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        lastActivityAtMs: nowMs,
        pendingStatus: null,
        dirty: false,
      };
      entries.set(taskId, entry);
    }
    entry.parentThreadId = parentThreadId;
    return entry;
  };

  const noteActivity: DeveloperTaskLiveStatusService["Service"]["noteActivity"] = (input) =>
    Effect.gen(function* () {
      const beat = beatForActivity(input.activity, input.workspaceRoot);
      // Idle under threshold returns null — keep the existing tool beat.
      if (input.activity.kind === "idle" && beat === null) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const entry = ensure(input.taskId, input.parentThreadId, nowMs);
      if (input.activity.kind !== "idle") entry.lastActivityAtMs = nowMs;
      if (beat === entry.pendingStatus) return;
      entry.pendingStatus = beat;
      entry.dirty = true;
    });

  const clear: DeveloperTaskLiveStatusService["Service"]["clear"] = (taskId) =>
    Effect.gen(function* () {
      const entry = entries.get(taskId);
      if (!entry) return;
      entries.delete(taskId);
      entry.liveStatus = null;
      entry.pendingStatus = null;
      entry.updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* PubSub.publish(changes, toStatus(taskId, entry));
    });

  const get: DeveloperTaskLiveStatusService["Service"]["get"] = (taskId) => {
    const entry = entries.get(taskId);
    return entry ? toStatus(taskId, entry) : null;
  };

  const subscribe: DeveloperTaskLiveStatusService["Service"]["subscribe"] = (filter) =>
    Effect.sync(() => {
      const snapshot: DeveloperTaskLiveStatus[] = [];
      for (const [taskId, entry] of entries) {
        const status = toStatus(taskId, entry);
        if (matchesFilter(filter, status)) snapshot.push(status);
      }
      const updates = Stream.fromPubSub(changes).pipe(
        Stream.filter((status) => matchesFilter(filter, status)),
        Stream.map((status): DeveloperTaskStatusStreamEvent => ({
          _tag: "updated",
          status,
        })),
      );
      return Stream.concat(
        Stream.succeed({ _tag: "snapshot", statuses: snapshot } as const),
        updates,
      );
    });

  const flushDirty = Effect.gen(function* () {
    for (const [taskId, entry] of entries) {
      if (!entry.dirty) continue;
      if (entry.pendingStatus === entry.liveStatus) {
        entry.dirty = false;
        continue;
      }
      entry.liveStatus = entry.pendingStatus;
      entry.updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
      entry.dirty = false;
      yield* PubSub.publish(changes, toStatus(taskId, entry));
    }
  });

  const tickIdle = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of entries.values()) {
      const idleMs = now - entry.lastActivityAtMs;
      if (idleMs <= BEAT_IDLE_THRESHOLD_MS) continue;
      const beat = beatForActivity({ kind: "idle", idleMs }, undefined);
      if (beat === null || beat === entry.pendingStatus) continue;
      entry.pendingStatus = beat;
      entry.dirty = true;
    }
  });

  const startPublisher: DeveloperTaskLiveStatusService["Service"]["startPublisher"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.millis(LIVE_STATUS_COALESCE_MS)).pipe(Effect.andThen(flushDirty)),
        ),
      );
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(Duration.seconds(15)).pipe(Effect.andThen(tickIdle))),
      );
    }).pipe(Effect.asVoid);

  return {
    noteActivity,
    clear,
    get,
    subscribe,
    startPublisher,
  } satisfies DeveloperTaskLiveStatusService["Service"];
});

export const layer = Layer.effect(DeveloperTaskLiveStatusService, makeDeveloperTaskLiveStatus);
