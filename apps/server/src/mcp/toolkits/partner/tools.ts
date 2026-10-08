import {
  DeveloperTaskFailure,
  DeveloperTaskId,
  DeveloperTaskPendingRequest,
  DeveloperTaskResult,
  DeveloperTaskScope,
  DeveloperTaskState,
  McpCapabilityUnavailableError,
  PartnerDecisionCardId,
  PartnerDecisionKind,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import {
  DelegationFailedError,
  DelegationRejectedError,
  DelegationSupervisor,
} from "../../../bots/DelegationSupervisor.ts";
import { DeveloperTaskLiveStatusService } from "../../../bots/DeveloperTaskLiveStatus.ts";
import { PartnerDecisionService } from "../../../bots/PartnerDecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  DelegationSupervisor,
  DeveloperTaskLiveStatusService,
  PartnerDecisionService,
];

export class PartnerThreadNotFoundError extends Schema.TaggedError<PartnerThreadNotFoundError>()(
  "PartnerThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

/** The caller's thread is a work thread, or has no partner bot bound to it. */
export class PartnerNotAvailableError extends Schema.TaggedError<PartnerNotAvailableError>()(
  "PartnerNotAvailableError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not a partner conversation.`;
  }
}

/** Unknown task, or a task that belongs to another thread or partner: the two look the same. */
export class DeveloperTaskNotFoundError extends Schema.TaggedError<DeveloperTaskNotFoundError>()(
  "DeveloperTaskNotFoundError",
  { taskId: Schema.String },
) {
  override get message(): string {
    return `Developer task ${this.taskId} was not found.`;
  }
}

/** The caller has no active turn to attribute the request to. */
export class PartnerTurnRequiredError extends Schema.TaggedError<PartnerTurnRequiredError>()(
  "PartnerTurnRequiredError",
  {},
) {
  override get message(): string {
    return "This conversation has no active turn.";
  }
}

export const PartnerToolError = Schema.Union([
  McpCapabilityUnavailableError,
  PartnerThreadNotFoundError,
  PartnerNotAvailableError,
  DeveloperTaskNotFoundError,
  PartnerTurnRequiredError,
  DelegationRejectedError,
  DelegationFailedError,
]);
export type PartnerToolError = typeof PartnerToolError.Type;

export const StartDeveloperTaskInput = Schema.Struct({
  goal: TrimmedNonEmptyString.annotate({
    description: "One sentence: what the developer should achieve.",
  }),
  context: Schema.optional(
    Schema.String.annotate({ description: "What you found, with file paths." }),
  ),
  constraints: Schema.optional(
    Schema.String.annotate({ description: "What the developer must not touch or do." }),
  ),
  acceptance: Schema.optional(
    Schema.String.annotate({ description: "What to run or check to know it is done." }),
  ),
  scope: Schema.optional(
    DeveloperTaskScope.annotate({ description: "Expected size of the change. Defaults to small." }),
  ),
});
export type StartDeveloperTaskInput = typeof StartDeveloperTaskInput.Type;

export const StartDeveloperTaskResult = Schema.Struct({
  taskId: DeveloperTaskId,
  status: Schema.Literals(["started", "queued", "needs_confirmation"]),
});
export type StartDeveloperTaskResult = typeof StartDeveloperTaskResult.Type;

const TaskTargetInput = Schema.Struct({
  taskId: DeveloperTaskId.annotate({ description: "The id start_developer_task returned." }),
});

export const CheckDeveloperTaskResult = Schema.Struct({
  taskId: DeveloperTaskId,
  goal: Schema.String,
  state: DeveloperTaskState,
  pendingRequest: Schema.NullOr(DeveloperTaskPendingRequest),
  result: Schema.NullOr(DeveloperTaskResult),
  failure: Schema.NullOr(DeveloperTaskFailure),
  /** Present-tense beat from the liveStatus stream; null when quiet or unknown. */
  liveStatus: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type CheckDeveloperTaskResult = typeof CheckDeveloperTaskResult.Type;

export const MessageDeveloperInput = Schema.Struct({
  taskId: DeveloperTaskId,
  text: TrimmedNonEmptyString.annotate({ description: "What to tell the developer." }),
});

export const AnswerDeveloperInput = Schema.Struct({
  taskId: DeveloperTaskId,
  requestId: TrimmedNonEmptyString.annotate({
    description: "The pendingRequest.requestId from check_developer_task.",
  }),
  decision: Schema.optional(
    Schema.Literals(["accept", "decline"]).annotate({
      description: "Required when the pending request is an approval.",
    }),
  ),
  answers: Schema.optional(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Required when the pending request is a question. Keyed by question id.",
    }),
  ),
});

export const AskUserInput = Schema.Struct({
  question: TrimmedNonEmptyString.annotate({
    description: "What to ask the user, in plain words. One or two sentences.",
  }),
  kind: PartnerDecisionKind.annotate({
    description:
      "approval draws Approve / Deny / Always allow buttons; question draws option buttons and a text box.",
  }),
  options: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Short answers to offer as buttons, for a question.",
    }),
  ),
  taskId: Schema.optional(
    DeveloperTaskId.annotate({ description: "The developer task this is about, if any." }),
  ),
  requestId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The pendingRequest.requestId the developer is waiting on. An approval answered Approve or Deny is passed to the developer for you.",
    }),
  ),
});
export type AskUserInput = typeof AskUserInput.Type;

export const AskUserResult = Schema.Struct({ cardId: PartnerDecisionCardId });
export type AskUserResult = typeof AskUserResult.Type;

export const DeveloperTaskStatusResult = Schema.Struct({
  status: Schema.Literals(["sent", "answered", "stopped", "task_finished"]),
});
export type DeveloperTaskStatusResult = typeof DeveloperTaskStatusResult.Type;

const StartDeveloperTaskTool = Tool.make("start_developer_task", {
  description:
    "Hand a code change to the developer. Pass a precise brief: goal, context, constraints, acceptance, and scope (use large for multi-file or risky work). Returns the task id immediately; the developer works in the background. If the status is needs_confirmation, the user sees a plan card with Go ahead and nothing starts until they approve it; tell them you are waiting for their go-ahead.",
  parameters: StartDeveloperTaskInput,
  success: StartDeveloperTaskResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start developer task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CheckDeveloperTaskTool = Tool.make("check_developer_task", {
  description:
    "Read a developer task: its state, any request waiting for an answer, and the result or failure.",
  parameters: TaskTargetInput,
  success: CheckDeveloperTaskResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check developer task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MessageDeveloperTool = Tool.make("message_developer", {
  description:
    "Send the developer a new instruction while the task is running. If the status is task_finished, the task already ended — start a new developer task instead of steering.",
  parameters: MessageDeveloperInput,
  success: DeveloperTaskStatusResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message developer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const AnswerDeveloperTool = Tool.make("answer_developer", {
  description:
    "Answer the request a developer task is waiting on. Approvals take a decision; questions take answers.",
  parameters: AnswerDeveloperInput,
  success: DeveloperTaskStatusResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Answer developer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const StopDeveloperTaskTool = Tool.make("stop_developer_task", {
  description: "Stop a developer task that is no longer wanted.",
  parameters: TaskTargetInput,
  success: DeveloperTaskStatusResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop developer task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AskUserTool = Tool.make("ask_user", {
  description:
    "Put a question or an approval to the user as a card in the chat. Use it only when the decision is truly theirs. Returns the card id immediately; stop after calling it. The user's answer arrives later as a <hybrid_event>.",
  parameters: AskUserInput,
  success: AskUserResult,
  failure: PartnerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const PartnerToolkit = Toolkit.make(
  StartDeveloperTaskTool,
  CheckDeveloperTaskTool,
  MessageDeveloperTool,
  AnswerDeveloperTool,
  StopDeveloperTaskTool,
  AskUserTool,
);
