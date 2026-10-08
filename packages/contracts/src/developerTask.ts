/**
 * HYBRID: developer-task (delegation) contracts.
 *
 * The partner bot starts work via a task record; a hidden work thread runs the
 * developer. Commands are server-internal; clients never invent them.
 */
import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { BotId, BotRuntimeMode } from "./bots.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DeveloperTaskId = TrimmedNonEmptyString.pipe(Schema.brand("DeveloperTaskId"));
export type DeveloperTaskId = typeof DeveloperTaskId.Type;

export const DeveloperTaskState = Schema.Literals([
  "awaiting-confirmation",
  "queued",
  "running",
  "waiting-on-bot",
  "waiting-on-user",
  "completed",
  "failed",
  "canceled",
]);
export type DeveloperTaskState = typeof DeveloperTaskState.Type;

export const DeveloperTaskScope = Schema.Literals(["small", "medium", "large"]);
export type DeveloperTaskScope = typeof DeveloperTaskScope.Type;

export const DeveloperTaskBrief = Schema.Struct({
  goal: TrimmedNonEmptyString,
  context: Schema.String,
  constraints: Schema.String,
  acceptance: Schema.String,
  scope: DeveloperTaskScope,
});
export type DeveloperTaskBrief = typeof DeveloperTaskBrief.Type;

/** Approval class for pending asks (policy engine fills this in Phase 5). */
export const ApprovalClass = Schema.Literals([
  "none",
  "install",
  "delete",
  "outside-workspace",
  "send",
  "production",
  "secrets",
  // HYBRID: inline code (python -c, node -e, ...) that cannot be classified; always asks.
  "opaque",
]);
export type ApprovalClass = typeof ApprovalClass.Type;

/** HYBRID: one command part an Always-allow click remembers, e.g. `git push origin main`. */
export const AlwaysAllowEntry = Schema.Struct({
  approvalClass: ApprovalClass,
  matchDetail: Schema.String,
});
export type AlwaysAllowEntry = typeof AlwaysAllowEntry.Type;

export const DeveloperTaskPendingRequest = Schema.Struct({
  requestId: ApprovalRequestId,
  kind: Schema.Literals(["approval", "question"]),
  summary: Schema.String,
  approvalClass: Schema.optional(ApprovalClass),
  /** Raw command/path used for deterministic Always-allow matching. */
  matchDetail: Schema.optional(Schema.String),
  /** Normalized non-`none` parts of the request; what Always allow stores. */
  alwaysAllow: Schema.optional(Schema.Array(AlwaysAllowEntry)),
});
export type DeveloperTaskPendingRequest = typeof DeveloperTaskPendingRequest.Type;

export const DeveloperTaskResultFile = Schema.Struct({
  path: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export const DeveloperTaskResultCheck = Schema.Struct({
  command: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "unknown"]),
});

export const DeveloperTaskResult = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(DeveloperTaskResultFile),
  checks: Schema.Array(DeveloperTaskResultCheck),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
});
export type DeveloperTaskResult = typeof DeveloperTaskResult.Type;

export const DeveloperTaskFailure = Schema.Struct({
  code: Schema.Literals(["timeout", "denied", "developer-failed", "interrupted", "internal"]),
  message: TrimmedNonEmptyString,
});
export type DeveloperTaskFailure = typeof DeveloperTaskFailure.Type;

/** Developer engine selection (same shape as Hatch / BotEngine). */
export const DeveloperTaskModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type DeveloperTaskModelSelection = typeof DeveloperTaskModelSelection.Type;

export const DeveloperTask = Schema.Struct({
  taskId: DeveloperTaskId,
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  workThreadId: Schema.NullOr(ThreadId),
  workTurnIds: Schema.Array(TurnId),
  botId: BotId,
  brief: DeveloperTaskBrief,
  runtimeMode: BotRuntimeMode,
  modelSelection: DeveloperTaskModelSelection,
  state: DeveloperTaskState,
  pendingRequest: Schema.NullOr(DeveloperTaskPendingRequest),
  result: Schema.NullOr(DeveloperTaskResult),
  failure: Schema.NullOr(DeveloperTaskFailure),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type DeveloperTask = typeof DeveloperTask.Type;

/** Message provenance — clients may only send origin "user". */
export const MessageOrigin = Schema.Literals(["user", "bot", "system-wake", "developer-brief"]);
export type MessageOrigin = typeof MessageOrigin.Type;

/** Message visibility — clients may only send visibility "user". */
export const MessageVisibility = Schema.Literals(["user", "internal"]);
export type MessageVisibility = typeof MessageVisibility.Type;

export const DEFAULT_MESSAGE_ORIGIN: MessageOrigin = "user";
export const DEFAULT_MESSAGE_VISIBILITY: MessageVisibility = "user";

export const ThreadKind = Schema.Literals(["chat", "work"]);
export type ThreadKind = typeof ThreadKind.Type;
export const DEFAULT_THREAD_KIND: ThreadKind = "chat";

// —— Plan-card confirmation (the one client-facing entry; commands below stay server-only) ——

export const DeveloperTaskConfirmationDecision = Schema.Literals(["confirm", "decline", "edit"]);
export type DeveloperTaskConfirmationDecision = typeof DeveloperTaskConfirmationDecision.Type;

/** The user's answer to a task parked in `awaiting-confirmation`. */
export const DeveloperTaskResolveConfirmationInput = Schema.Struct({
  taskId: DeveloperTaskId,
  decision: DeveloperTaskConfirmationDecision,
});
export type DeveloperTaskResolveConfirmationInput =
  typeof DeveloperTaskResolveConfirmationInput.Type;

export const DeveloperTaskConfirmationError = Schema.Struct({
  code: Schema.Literals(["rejected", "failed"]),
  message: TrimmedNonEmptyString,
});
export type DeveloperTaskConfirmationError = typeof DeveloperTaskConfirmationError.Type;

/** The user's Stop on a work card. The server decides what each state allows. */
export const DeveloperTaskStopInput = Schema.Struct({
  taskId: DeveloperTaskId,
});
export type DeveloperTaskStopInput = typeof DeveloperTaskStopInput.Type;

// —— Task records for one parent thread (work cards) ——

export const DeveloperTaskListSubscribeInput = Schema.Struct({
  parentThreadId: ThreadId,
});
export type DeveloperTaskListSubscribeInput = typeof DeveloperTaskListSubscribeInput.Type;

/** Every task the parent thread started, then each task again whenever it changes. */
export const DeveloperTaskListStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    tasks: Schema.Array(DeveloperTask),
  }),
  Schema.TaggedStruct("upserted", {
    task: DeveloperTask,
  }),
]);
export type DeveloperTaskListStreamEvent = typeof DeveloperTaskListStreamEvent.Type;

// —— Live status beats (ephemeral; not in the event store) ——

/** One task's present-tense beat for the work card / partner face. */
export const DeveloperTaskLiveStatus = Schema.Struct({
  taskId: DeveloperTaskId,
  parentThreadId: ThreadId,
  liveStatus: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type DeveloperTaskLiveStatus = typeof DeveloperTaskLiveStatus.Type;

export const DeveloperTaskStatusSubscribeInput = Schema.Struct({
  /** When set, only statuses for tasks whose parent is this thread. */
  parentThreadId: Schema.optional(ThreadId),
  /** When set, only this task. */
  taskId: Schema.optional(DeveloperTaskId),
});
export type DeveloperTaskStatusSubscribeInput = typeof DeveloperTaskStatusSubscribeInput.Type;

export const DeveloperTaskStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    statuses: Schema.Array(DeveloperTaskLiveStatus),
  }),
  Schema.TaggedStruct("updated", {
    status: DeveloperTaskLiveStatus,
  }),
]);
export type DeveloperTaskStatusStreamEvent = typeof DeveloperTaskStatusStreamEvent.Type;

// —— Commands (server-internal; wired into OrchestrationCommand in orchestration.ts) ——

export const DeveloperTaskCreateCommand = Schema.Struct({
  type: Schema.Literal("developerTask.create"),
  commandId: CommandId,
  taskId: DeveloperTaskId,
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  botId: BotId,
  brief: DeveloperTaskBrief,
  runtimeMode: BotRuntimeMode,
  modelSelection: DeveloperTaskModelSelection,
  createdAt: IsoDateTime,
});
export type DeveloperTaskCreateCommand = typeof DeveloperTaskCreateCommand.Type;

export const DeveloperTaskStateSetCommand = Schema.Struct({
  type: Schema.Literal("developerTask.state.set"),
  commandId: CommandId,
  taskId: DeveloperTaskId,
  state: DeveloperTaskState,
  workThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  pendingRequest: Schema.optional(Schema.NullOr(DeveloperTaskPendingRequest)),
  result: Schema.optional(Schema.NullOr(DeveloperTaskResult)),
  failure: Schema.optional(Schema.NullOr(DeveloperTaskFailure)),
  createdAt: IsoDateTime,
});
export type DeveloperTaskStateSetCommand = typeof DeveloperTaskStateSetCommand.Type;

export const DeveloperTaskSteerCommand = Schema.Struct({
  type: Schema.Literal("developerTask.steer"),
  commandId: CommandId,
  taskId: DeveloperTaskId,
  text: TrimmedNonEmptyString,
  turnId: TurnId,
  createdAt: IsoDateTime,
});
export type DeveloperTaskSteerCommand = typeof DeveloperTaskSteerCommand.Type;

export const DeveloperTaskCancelCommand = Schema.Struct({
  type: Schema.Literal("developerTask.cancel"),
  commandId: CommandId,
  taskId: DeveloperTaskId,
  createdAt: IsoDateTime,
});
export type DeveloperTaskCancelCommand = typeof DeveloperTaskCancelCommand.Type;

export const DeveloperTaskCommand = Schema.Union([
  DeveloperTaskCreateCommand,
  DeveloperTaskStateSetCommand,
  DeveloperTaskSteerCommand,
  DeveloperTaskCancelCommand,
]);
export type DeveloperTaskCommand = typeof DeveloperTaskCommand.Type;

export const isDeveloperTaskCommandType = (type: string): boolean =>
  type === "developerTask.create" ||
  type === "developerTask.state.set" ||
  type === "developerTask.steer" ||
  type === "developerTask.cancel";

// —— Events ——

export const DeveloperTaskCreatedPayload = Schema.Struct({
  task: DeveloperTask,
});
export type DeveloperTaskCreatedPayload = typeof DeveloperTaskCreatedPayload.Type;

export const DeveloperTaskStateSetPayload = Schema.Struct({
  taskId: DeveloperTaskId,
  state: DeveloperTaskState,
  workThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  pendingRequest: Schema.optional(Schema.NullOr(DeveloperTaskPendingRequest)),
  result: Schema.optional(Schema.NullOr(DeveloperTaskResult)),
  failure: Schema.optional(Schema.NullOr(DeveloperTaskFailure)),
  updatedAt: IsoDateTime,
  startedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  completedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type DeveloperTaskStateSetPayload = typeof DeveloperTaskStateSetPayload.Type;

export const DeveloperTaskSteeredPayload = Schema.Struct({
  taskId: DeveloperTaskId,
  turnId: TurnId,
  text: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type DeveloperTaskSteeredPayload = typeof DeveloperTaskSteeredPayload.Type;
