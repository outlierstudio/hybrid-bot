/**
 * HYBRID: DelegationSupervisor — the server side of the partner toolkit.
 *
 * Owns a developer task from creation to a terminal state (AUDIT §5.4):
 *
 * - `start` creates the task, resolves its runtime mode from the bot's autonomy and the
 *   brief's scope (never from model text), takes the per-worktree write lock, and launches
 *   the work thread. When the lock is held the task stays `queued` and is promoted when the
 *   holder finishes.
 * - Launching server-dispatches `thread.create` (kind "work", same project, worktree, and
 *   branch) and a `thread.turn.start` carrying the developer brief (origin "developer-brief").
 * - `startReactor` rehydrates non-terminal tasks on boot and watches work-thread events:
 *   turn completion builds the result from checkpoint summaries and the developer's final
 *   message; session errors and interrupts fail the task; approvals go through
 *   the PolicyEngine (allow accepts, never declines, ask parks the task as `waiting-on-bot`
 *   and wakes the partner); developer questions park the task as `waiting-on-bot`.
 *
 * Callers authorize first (the MCP handlers check capability, parent thread, and partner).
 * The supervisor only validates the task's own state.
 */
import { isHybridEngineDriver } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  type ApprovalClass,
  type BotId,
  CommandId,
  DeveloperTaskId,
  type DeveloperTask,
  type DeveloperTaskBrief,
  type DeveloperTaskFailure,
  type DeveloperTaskListStreamEvent,
  type DeveloperTaskResult,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  PARTNER_DECISION_ACTIVITY_KIND,
  PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isTerminalDeveloperTaskState } from "../orchestration/developerTaskProjection.ts";
import { ProjectionDeveloperTaskRepository } from "../persistence/Services/ProjectionDeveloperTasks.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import * as BotRegistry from "./BotRegistry.ts";
import * as DeveloperTaskLiveStatus from "./DeveloperTaskLiveStatus.ts";
import {
  beatActivityFromThreadActivity,
  DeveloperTaskLiveStatusService,
} from "./DeveloperTaskLiveStatus.ts";
import { PartnerWakeScheduler } from "./PartnerWakeScheduler.ts";
import { PolicyEngine } from "./policy/PolicyEngine.ts";

/** The request is well formed but the task cannot take it in its current state. */
export class DelegationRejectedError extends Schema.TaggedError<DelegationRejectedError>()(
  "DelegationRejectedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** An infrastructure failure: persistence or command dispatch. */
export class DelegationFailedError extends Schema.TaggedError<DelegationFailedError>()(
  "DelegationFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The developer task operation failed.";
  }
}

export type DelegationError = DelegationRejectedError | DelegationFailedError;

/** `needs_confirmation`: the task waits for the user's go-ahead and nothing has launched. */
export type DelegationStartStatus = "started" | "queued" | "needs_confirmation";

export interface DelegationStartInput {
  /** The partner's chat thread. The work thread inherits its project, worktree, and branch. */
  readonly thread: Pick<
    OrchestrationThreadShell,
    "id" | "modelSelection" | "projectId" | "worktreePath" | "branch"
  >;
  readonly parentTurnId: TurnId;
  readonly botId: BotId;
  readonly brief: DeveloperTaskBrief;
}

export interface DelegationAnswerInput {
  readonly taskId: DeveloperTaskId;
  readonly requestId: string;
  readonly decision?: Extract<ProviderApprovalDecision, "accept" | "decline">;
  readonly answers?: Readonly<Record<string, string>>;
  /**
   * Set only by PartnerDecisionService after the user clicks Approve / Always allow.
   * Without this, the bot cannot accept delete / outside-workspace / send / production / secrets.
   */
  readonly userGranted?: boolean;
}

/** Classes the bot may accept via answer_developer without a user decision card. */
export function botMayAcceptApprovalClass(approvalClass: ApprovalClass | undefined): boolean {
  return approvalClass === "none" || approvalClass === "install";
}

/** Wake instruction after approval.requested — accept only when the bot may accept the class. */
export function afterForApprovalRequested(approvalClass: ApprovalClass | undefined): string {
  if (botMayAcceptApprovalClass(approvalClass)) {
    return "The developer is waiting on an approval your policy does not allow automatically. Decide with answer_developer (accept or decline), or put it to the user with ask_user (pass the task_id and request_id) and stop. Do not repeat this block.";
  }
  return "The developer is waiting on an approval your policy does not allow automatically. Decline it with answer_developer, or ask the user with ask_user (pass the task_id and request_id) and stop. Do not accept it yourself. Do not repeat this block.";
}

export class DelegationSupervisor extends Context.Service<
  DelegationSupervisor,
  {
    /**
     * Creates the developer task and launches it, queues it behind the worktree's writer, or
     * parks it as `awaiting-confirmation` when the bot's policy needs the user's go-ahead first.
     */
    readonly start: (input: DelegationStartInput) => Effect.Effect<
      {
        readonly taskId: DeveloperTaskId;
        readonly status: DelegationStartStatus;
      },
      DelegationError
    >;
    readonly check: (
      taskId: DeveloperTaskId,
    ) => Effect.Effect<Option.Option<DeveloperTask>, DelegationError>;
    readonly message: (input: {
      readonly taskId: DeveloperTaskId;
      readonly turnId: TurnId;
      readonly text: string;
    }) => Effect.Effect<void, DelegationError>;
    readonly answer: (input: DelegationAnswerInput) => Effect.Effect<void, DelegationError>;
    readonly stop: (taskId: DeveloperTaskId) => Effect.Effect<void, DelegationError>;
    /**
     * Every task one parent thread started, then each task again whenever it changes. The work
     * cards render from this; no client message text is involved.
     */
    readonly watch: (
      parentThreadId: ThreadId,
    ) => Effect.Effect<
      Stream.Stream<DeveloperTaskListStreamEvent, DelegationError>,
      DelegationError,
      Scope.Scope
    >;
    /**
     * The user's go-ahead on an `awaiting-confirmation` task: takes the worktree write lock and
     * launches (or queues). Confirming a task that is already queued or running is a no-op.
     */
    readonly confirm: (taskId: DeveloperTaskId) => Effect.Effect<void, DelegationError>;
    /** The user's "not now" on an `awaiting-confirmation` task: cancels it. */
    readonly decline: (taskId: DeveloperTaskId) => Effect.Effect<void, DelegationError>;
    /**
     * The user's "edit" on an `awaiting-confirmation` task: cancels it like decline (no work
     * thread) and wakes the partner to revise the plan and propose it again.
     */
    readonly edit: (taskId: DeveloperTaskId) => Effect.Effect<void, DelegationError>;
    /** Rehydrates non-terminal tasks, then follows work-thread events for the scope's lifetime. */
    readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
    /** Applies one orchestration event. Exposed so tests can drive the supervisor deterministically. */
    readonly handleEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  }
>()("t3/bots/DelegationSupervisor") {}

type RuntimeMode = DeveloperTask["runtimeMode"];

/**
 * The runtime mode a task runs under. Comes from the bot's autonomy and the brief's own scope
 * estimate, never from anything the model wrote. A read-only bot never gets past approvals.
 */
export function resolveDeveloperRuntimeMode(input: {
  readonly autonomy: "ask-first" | "small-changes" | "full";
  readonly scope: DeveloperTaskBrief["scope"];
  readonly readOnly: boolean;
}): RuntimeMode {
  if (input.readOnly) return "approval-required";
  switch (input.autonomy) {
    case "ask-first":
      return "approval-required";
    case "small-changes":
      // A large change is more than "small changes": every step needs approval.
      return input.scope === "large" ? "approval-required" : "auto-accept-edits";
    case "full":
      return "full-access";
  }
}

/**
 * Whether the user must say "go ahead" before the developer starts. Like the runtime mode, this
 * comes from the bot's autonomy and the brief's own scope estimate, never from model text.
 */
export function requiresConfirmation(input: {
  readonly autonomy: "ask-first" | "small-changes" | "full";
  readonly scope: DeveloperTaskBrief["scope"];
  readonly readOnly: boolean;
}): boolean {
  if (input.readOnly) return true;
  switch (input.autonomy) {
    case "ask-first":
      return true;
    case "small-changes":
      return input.scope === "large";
    case "full":
      return false;
  }
}

/** AUDIT §5.9 developer brief: the first message of the work thread. */
export function formatDeveloperBrief(input: {
  readonly botName: string;
  readonly brief: DeveloperTaskBrief;
}): string {
  const field = (value: string) => (value.trim().length > 0 ? value.trim() : "(none given)");
  return [
    `You are implementing a change requested by the user through their associate ${input.botName}. Work autonomously in this repository and finish the job.`,
    "",
    `Goal: ${input.brief.goal}`,
    `Context: ${field(input.brief.context)}`,
    `Constraints: ${field(input.brief.constraints)}`,
    `Done when: ${field(input.brief.acceptance)}`,
    "",
    "Rules",
    "- Make the smallest change that satisfies the goal. Follow existing code style.",
    '- Run the checks listed in "Done when". If none are listed, run the project\'s relevant tests or typecheck.',
    "- If something is ambiguous and you cannot make a safe assumption, ask one question.",
    "- End with a short summary: what you changed (files), what you ran, results, and anything left undone.",
  ].join("\n");
}

const SUMMARY_LIMIT = 10_000;
/** The checkpoint reactor captures a turn's files independently of the session going ready. */
const CHECKPOINT_POLL_ATTEMPTS = 10;
const CHECKPOINT_POLL_INTERVAL = Duration.millis(150);

const lockKeyOf = (input: {
  readonly projectId: string;
  readonly worktreePath: string | null;
}): string => `${input.projectId}\u0000${input.worktreePath ?? ""}`;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const tasks = yield* ProjectionDeveloperTaskRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const bots = yield* BotRegistry.BotRegistry;
  const crypto = yield* Crypto.Crypto;
  const liveStatus = yield* DeveloperTaskLiveStatusService;
  const wakes = yield* PartnerWakeScheduler;
  const policy = yield* PolicyEngine;

  // In-memory by design (AUDIT §5.4): the locks are rebuilt from the projection on boot.
  /** lock key → task that holds the worktree's write lock. */
  const lockHolders = new Map<string, DeveloperTaskId>();
  /** lock key → tasks waiting for the lock, oldest first. */
  const lockQueues = new Map<string, Array<DeveloperTaskId>>();
  const lockKeyByTask = new Map<DeveloperTaskId, string>();
  const taskByWorkThread = new Map<ThreadId, DeveloperTaskId>();
  /** Tasks whose current work turn has been seen running, so a later "ready" means done. */
  const turnSeenRunning = new Set<DeveloperTaskId>();
  const handledRequests = new Set<string>();

  const failed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, DelegationFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new DelegationFailedError({ cause }));

  const commandId = (tag: string, key: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      // The `server:` prefix is what the decider requires of developer-task commands.
      Effect.map((uuid) => CommandId.make(`server:${tag}:${key}:${uuid}`)),
    );

  /** A command id the same operation always gets, so a retried launch step is a no-op. */
  const stableCommandId = (tag: string, key: string) => CommandId.make(`server:${tag}:${key}`);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const load = (taskId: DeveloperTaskId) =>
    tasks.getById({ taskId }).pipe(Effect.catchCause(failed));

  const requireTask = (taskId: DeveloperTaskId) =>
    load(taskId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new DelegationRejectedError({ reason: "Task not found." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause): Effect.Effect<never, DelegationError> => {
        // The decider rejects a command the task's state cannot take (for example a finished task).
        const error = Cause.findErrorOption(cause);
        return Option.isSome(error) && error.value._tag === "OrchestrationCommandInvariantError"
          ? Effect.fail(new DelegationRejectedError({ reason: error.value.detail }))
          : failed(cause);
      }),
    );

  const logAndContinue = (message: string) =>
    Effect.catchCause((cause: Cause.Cause<unknown>): Effect.Effect<void> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      return Effect.logWarning(message, { cause: Cause.pretty(cause) });
    });

  // —— write lock ——

  const lockKeyForParent = (parentThreadId: ThreadId) =>
    snapshots.getThreadShellById(parentThreadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => `orphan\u0000${parentThreadId}`,
          onSome: (thread) => lockKeyOf(thread),
        }),
      ),
      Effect.catchCause(failed),
    );

  const enqueue = (key: string, taskId: DeveloperTaskId) => {
    lockKeyByTask.set(taskId, key);
    const queue = lockQueues.get(key) ?? [];
    if (!queue.includes(taskId)) queue.push(taskId);
    lockQueues.set(key, queue);
  };

  /** Called whenever a task reaches a terminal state: frees the lock and starts the next task. */
  const release: (taskId: DeveloperTaskId) => Effect.Effect<void> = Effect.fn(
    "DelegationSupervisor.release",
  )(function* (taskId) {
    yield* liveStatus.clear(taskId);
    const key = lockKeyByTask.get(taskId);
    lockKeyByTask.delete(taskId);
    turnSeenRunning.delete(taskId);
    if (key === undefined) return;
    const queue = lockQueues.get(key);
    if (queue !== undefined) {
      const index = queue.indexOf(taskId);
      if (index >= 0) queue.splice(index, 1);
    }
    if (lockHolders.get(key) === taskId) {
      lockHolders.delete(key);
      yield* promote(key);
    }
  });

  const promote: (key: string) => Effect.Effect<void> = Effect.fn("DelegationSupervisor.promote")(
    function* (key) {
      while (!lockHolders.has(key)) {
        const next = lockQueues.get(key)?.shift();
        if (next === undefined) {
          lockQueues.delete(key);
          return;
        }
        const task = yield* tasks
          .getById({ taskId: next })
          .pipe(Effect.catchCause(() => Effect.succeedNone));
        if (
          Option.isNone(task) ||
          task.value.state !== "queued" ||
          task.value.workThreadId !== null
        ) {
          continue;
        }
        // The lookup yielded; another start may have taken the lock meanwhile.
        if (lockHolders.has(key)) {
          lockQueues.get(key)?.unshift(next);
          return;
        }
        lockHolders.set(key, next);
        yield* launch(task.value).pipe(logAndContinue("developer task launch failed"));
      }
    },
  );

  // —— state transitions ——

  const setState = (
    taskId: DeveloperTaskId,
    patch: Omit<
      Extract<Parameters<typeof engine.dispatch>[0], { type: "developerTask.state.set" }>,
      "type" | "commandId" | "taskId" | "createdAt"
    >,
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "developerTask.state.set",
        commandId: yield* commandId("developer-task-state", taskId),
        taskId,
        createdAt: yield* now,
        ...patch,
      });
    });

  /**
   * Closes the decision cards a finished task left open. The developer is gone, so the card
   * can no longer be answered, and an open card keeps the partner thread flagged as waiting
   * on the user.
   */
  const retireDecisionCards = (task: DeveloperTask) =>
    Effect.gen(function* () {
      const thread = yield* snapshots
        .getThreadDetailById(task.parentThreadId, {
          activityKinds: [PARTNER_DECISION_ACTIVITY_KIND, PARTNER_DECISION_RESOLVED_ACTIVITY_KIND],
        })
        .pipe(Effect.catchCause(failed));
      if (Option.isNone(thread)) return;
      const answered = new Set<string>();
      for (const activity of thread.value.activities) {
        if (activity.kind !== PARTNER_DECISION_RESOLVED_ACTIVITY_KIND) continue;
        const cardId = (activity.payload as { cardId?: unknown } | null)?.cardId;
        if (typeof cardId === "string") answered.add(cardId);
      }
      for (const activity of thread.value.activities) {
        if (activity.kind !== PARTNER_DECISION_ACTIVITY_KIND) continue;
        const payload = activity.payload as { cardId?: unknown; taskId?: unknown } | null;
        const cardId = payload?.cardId;
        if (typeof cardId !== "string" || answered.has(cardId) || payload?.taskId !== task.taskId) {
          continue;
        }
        const createdAt = yield* now;
        // The same command id PartnerDecisionService uses, so a racing answer lands once.
        yield* dispatch({
          type: "thread.activity.append",
          commandId: stableCommandId(PARTNER_DECISION_RESOLVED_ACTIVITY_KIND, `${cardId}:resolved`),
          threadId: task.parentThreadId,
          activity: {
            id: EventId.make(yield* newUuid),
            tone: "info",
            kind: PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
            summary: "Decision no longer needed.",
            payload: { cardId, decision: "decline", retired: true },
            turnId: null,
            createdAt,
          },
          createdAt,
        });
      }
    }).pipe(logAndContinue("open decision cards could not be retired"));

  const failTask = (
    taskId: DeveloperTaskId,
    code: DeveloperTaskFailure["code"],
    message: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const existing = yield* load(taskId);
      // Keep the checkpoint diff even when the task fails so the partner sees
      // what actually changed, regardless of what the developer claimed.
      const checkpointResult =
        Option.isSome(existing) && existing.value.workThreadId !== null
          ? yield* buildResult(existing.value.workThreadId).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            )
          : null;
      const result =
        checkpointResult === null
          ? null
          : {
              ...checkpointResult,
              summary:
                checkpointResult.summary.length > 0 &&
                checkpointResult.summary !== "The developer finished without a final message."
                  ? checkpointResult.summary
                  : message,
            };
      yield* setState(taskId, {
        state: "failed",
        failure: { code, message },
        ...(result !== null ? { result } : {}),
      });
      const task = yield* load(taskId);
      if (Option.isSome(task)) {
        yield* retireDecisionCards(task.value);
        yield* wakes.notify({
          kind: code === "interrupted" ? "task.interrupted" : "task.failed",
          task: task.value,
        });
      }
    }).pipe(
      logAndContinue("developer task could not be marked failed"),
      Effect.ensuring(release(taskId)),
    );

  const appendCompletedActivity = (task: DeveloperTask, result: DeveloperTaskResult) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("developer-task-completed", task.taskId),
        threadId: task.parentThreadId,
        activity: {
          id: EventId.make(yield* newUuid),
          tone: "info",
          kind: "developer-task.completed",
          summary: result.summary.length > 0 ? clip(result.summary) : "Developer task completed.",
          payload: {
            taskId: task.taskId,
            workThreadId: task.workThreadId,
            result,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(logAndContinue("developer-task.completed activity could not be appended"));

  /** Marks the parent-thread timeline so the web can draw (and later retire) the plan card. */
  const appendPlanActivity = (
    task: DeveloperTask,
    entry:
      | { readonly kind: "developer-task.plan"; readonly summary: string }
      | {
          readonly kind: "developer-task.plan.resolved";
          readonly decision: "confirmed" | "declined" | "edit";
        },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      const isPlan = entry.kind === "developer-task.plan";
      yield* dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId(`${entry.kind}`, task.taskId),
        threadId: task.parentThreadId,
        activity: {
          id: EventId.make(yield* newUuid),
          tone: "info",
          kind: entry.kind,
          summary: isPlan
            ? entry.summary
            : entry.decision === "edit"
              ? "Plan sent back for edits."
              : `Plan ${entry.decision}.`,
          payload: isPlan
            ? {
                taskId: task.taskId,
                goal: task.brief.goal,
                context: task.brief.context,
                scope: task.brief.scope,
              }
            : { taskId: task.taskId, decision: entry.decision },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(logAndContinue(`${entry.kind} activity could not be appended`));

  const completeTask = (
    taskId: DeveloperTaskId,
    result: DeveloperTaskResult,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const task = yield* load(taskId);
      yield* setState(taskId, { state: "completed", result });
      if (Option.isSome(task)) {
        const completed = { ...task.value, state: "completed" as const, result };
        yield* appendCompletedActivity(task.value, result);
        yield* wakes.notify({ kind: "task.completed", task: completed });
      }
    }).pipe(
      logAndContinue("developer task could not be marked completed"),
      Effect.ensuring(release(taskId)),
    );

  // —— launching ——

  const workThreadIdOf = (taskId: DeveloperTaskId) => ThreadId.make(`work-${taskId}`);

  /** Server-dispatches a message into the developer's work thread. */
  const sendToDeveloper = (
    task: DeveloperTask,
    workThreadId: ThreadId,
    input: {
      readonly text: string;
      readonly origin: "developer-brief" | "bot";
      readonly commandId: CommandId;
    },
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.turn.start",
        commandId: input.commandId,
        threadId: workThreadId,
        message: {
          messageId: MessageId.make(yield* newUuid),
          role: "user",
          text: input.text,
          attachments: [],
          origin: input.origin,
          visibility: "internal",
          developerTaskId: task.taskId,
        },
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: "default",
        createdAt: yield* now,
      });
    });

  /** Creates the work thread and starts the developer's first turn. The lock is already held. */
  const launch = (task: DeveloperTask): Effect.Effect<void, DelegationError> =>
    Effect.gen(function* () {
      const parent = yield* snapshots
        .getThreadShellById(task.parentThreadId)
        .pipe(Effect.catchCause(failed));
      if (Option.isNone(parent)) {
        return yield* new DelegationRejectedError({ reason: "The partner thread is gone." });
      }
      const bot = yield* bots.get(task.botId).pipe(
        Effect.map((value) => value.name),
        Effect.orElseSucceed(() => "your partner"),
      );
      const workThreadId = workThreadIdOf(task.taskId);
      const createdAt = yield* now;
      yield* dispatch({
        type: "thread.create",
        commandId: stableCommandId("developer-task-work-thread", task.taskId),
        threadId: workThreadId,
        projectId: parent.value.projectId,
        title: `Developer: ${task.brief.goal}`.slice(0, 80).trim(),
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: "default",
        branch: parent.value.branch,
        worktreePath: parent.value.worktreePath,
        createdAt,
        kind: "work",
        parentThreadId: task.parentThreadId,
        partnerBotId: null,
      });
      taskByWorkThread.set(workThreadId, task.taskId);
      yield* setState(task.taskId, { state: "running", workThreadId });
      yield* sendToDeveloper(task, workThreadId, {
        text: formatDeveloperBrief({ botName: bot, brief: task.brief }),
        origin: "developer-brief",
        commandId: stableCommandId("developer-task-brief", task.taskId),
      });
    }).pipe(
      Effect.tapError((error) =>
        failTask(
          task.taskId,
          "internal",
          error._tag === "DelegationRejectedError"
            ? error.reason
            : "The developer could not be started.",
        ),
      ),
    );

  // —— turn completion ——

  const clip = (text: string) =>
    text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;

  /** Result from the checkpoint file summaries and the developer's last message. */
  const buildResult = (workThreadId: ThreadId) =>
    Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        const detail = yield* snapshots
          .getThreadDetailById(workThreadId)
          .pipe(Effect.catchCause(failed));
        if (Option.isNone(detail)) {
          return {
            summary: "The developer finished, but the work thread could not be read.",
            filesChanged: [],
            checks: [],
            checkpointTurnCount: null,
          } satisfies DeveloperTaskResult;
        }
        const thread = detail.value;
        const latestTurnId = thread.latestTurn?.turnId ?? null;
        const checkpoints = thread.checkpoints.filter(
          (checkpoint) => checkpoint.status === "ready",
        );
        const captured =
          latestTurnId === null ||
          thread.checkpoints.some((checkpoint) => checkpoint.turnId === latestTurnId);
        attempt += 1;
        if (!captured && attempt < CHECKPOINT_POLL_ATTEMPTS) {
          yield* Effect.sleep(CHECKPOINT_POLL_INTERVAL);
          continue;
        }

        const byPath = new Map<string, { additions: number; deletions: number }>();
        for (const checkpoint of checkpoints) {
          for (const file of checkpoint.files) {
            const total = byPath.get(file.path) ?? { additions: 0, deletions: 0 };
            byPath.set(file.path, {
              additions: total.additions + file.additions,
              deletions: total.deletions + file.deletions,
            });
          }
        }
        const assistant = thread.messages.filter(
          (message) => message.role === "assistant" && !message.streaming,
        );
        const finalMessage =
          assistant.findLast((message) => message.turnId === latestTurnId) ?? assistant.at(-1);
        const summary = finalMessage?.text.trim() ?? "";
        const lastCheckpoint = checkpoints.reduce<number | null>(
          (max, checkpoint) => Math.max(max ?? 0, checkpoint.checkpointTurnCount),
          null,
        );
        return {
          summary:
            summary.length > 0 ? clip(summary) : "The developer finished without a final message.",
          filesChanged: [...byPath].map(([path, total]) => ({ path, ...total })),
          // Recognising check commands from tool activity is a later phase; unknown is honest.
          checks: [],
          checkpointTurnCount: lastCheckpoint,
        } satisfies DeveloperTaskResult;
      }
    });

  const finishTurn = (task: DeveloperTask, workThreadId: ThreadId) =>
    buildResult(workThreadId).pipe(
      Effect.flatMap((result) => completeTask(task.taskId, result)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : failTask(task.taskId, "internal", "The developer finished, but its result was lost."),
      ),
    );

  // —— work-thread events ——

  const textOf = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  const onSession = Effect.fn("DelegationSupervisor.onSession")(function* (
    task: DeveloperTask,
    event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
  ) {
    const session = event.payload.session;
    switch (session.status) {
      case "running":
        turnSeenRunning.add(task.taskId);
        return;
      case "ready":
        if (!turnSeenRunning.has(task.taskId)) return;
        turnSeenRunning.delete(task.taskId);
        return yield* finishTurn(task, event.payload.threadId);
      case "error":
        return yield* failTask(
          task.taskId,
          "developer-failed",
          session.lastError ?? "The developer's session failed.",
        );
      case "interrupted":
        return yield* failTask(task.taskId, "interrupted", "The developer was interrupted.");
      case "stopped":
        return yield* failTask(task.taskId, "interrupted", "The developer's session stopped.");
      default:
        return;
    }
  });

  /** Reads the worktree root and project the developer works in, for the approval policy. */
  const workContextOf = (workThreadId: ThreadId) =>
    snapshots.getThreadCheckpointContext(workThreadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (context) => ({
            root: context.worktreePath ?? context.workspaceRoot,
            projectId: context.projectId as string,
          }),
        }),
      ),
      Effect.catchCause(failed),
    );

  const respondToApproval = (
    workThreadId: ThreadId,
    requestId: string,
    decision: "accept" | "decline",
  ) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.approval.respond",
        commandId: yield* commandId("developer-task-approval", requestId),
        threadId: workThreadId,
        requestId: ApprovalRequestId.make(requestId),
        decision,
        createdAt: yield* now,
      });
    });

  const onApprovalRequested = Effect.fn("DelegationSupervisor.onApprovalRequested")(function* (
    task: DeveloperTask,
    workThreadId: ThreadId,
    payload: Readonly<Record<string, unknown>>,
  ) {
    const requestId = textOf(payload.requestId);
    if (requestId === undefined || handledRequests.has(requestId)) return;
    handledRequests.add(requestId);

    const context = yield* workContextOf(workThreadId);
    const detail = textOf(payload.detail);
    const requestKind = payload.requestKind as ProviderRequestKind | undefined;
    const requestLine = `request: ${detail ?? textOf(payload.requestKind) ?? "approval"}`;

    if (context === null) {
      yield* declineApproval(
        task,
        workThreadId,
        requestId,
        requestLine,
        "The worktree could not be found, so nothing can be approved.",
      );
      return;
    }

    const bot = yield* bots.get(task.botId).pipe(Effect.option);
    const outcome = yield* policy.decide({
      requestKind,
      detail,
      workspaceRoot: context.root,
      // A bot that cannot be read gets the most cautious defaults.
      autonomy: Option.isSome(bot) ? bot.value.autonomy : "ask-first",
      projectId: context.projectId,
      botId: task.botId,
    });

    switch (outcome.outcome) {
      case "allow":
        yield* respondToApproval(workThreadId, requestId, "accept");
        return;
      case "never":
        yield* declineApproval(task, workThreadId, requestId, requestLine, outcome.reason);
        return;
      case "ask":
        // No auto-response: the developer stays blocked until the partner (or the user) answers.
        yield* setState(task.taskId, {
          state: "waiting-on-bot",
          pendingRequest: {
            requestId: ApprovalRequestId.make(requestId),
            kind: "approval",
            summary: outcome.summary,
            approvalClass: outcome.approvalClass,
            ...(detail !== undefined ? { matchDetail: detail } : {}),
            ...(outcome.alwaysAllow.length > 0 ? { alwaysAllow: outcome.alwaysAllow } : {}),
          },
        });
        yield* wakes.notify({
          kind: "approval.requested",
          task,
          bodyLines: [requestLine, `class: ${outcome.approvalClass}`, `request_id: ${requestId}`],
          after: afterForApprovalRequested(outcome.approvalClass),
        });
        return;
    }
  });

  const declineApproval = (
    task: DeveloperTask,
    workThreadId: ThreadId,
    requestId: string,
    requestLine: string,
    reason: string,
  ) =>
    Effect.gen(function* () {
      yield* respondToApproval(workThreadId, requestId, "decline");
      // The provider only learns "declined"; the reason has to reach the developer as a message.
      yield* sendToDeveloper(task, workThreadId, {
        text: `Your request was declined: ${reason}`,
        origin: "bot",
        commandId: yield* commandId("developer-task-declined", requestId),
      });
      // The partner decides what to do when a hard decline blocks progress.
      yield* wakes.notify({
        kind: "approval.declined",
        task,
        bodyLines: [requestLine, `reason: ${reason}`],
      });
    });

  const onQuestion = Effect.fn("DelegationSupervisor.onQuestion")(function* (
    task: DeveloperTask,
    payload: Readonly<Record<string, unknown>>,
  ) {
    const requestId = textOf(payload.requestId);
    if (requestId === undefined || handledRequests.has(requestId)) return;
    handledRequests.add(requestId);
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const first = questions[0] as { question?: unknown } | undefined;
    yield* setState(task.taskId, {
      state: "waiting-on-bot",
      pendingRequest: {
        requestId: ApprovalRequestId.make(requestId),
        kind: "question",
        summary: textOf(first?.question) ?? "The developer has a question.",
      },
    });
  });

  const publishBeat = (task: DeveloperTask, activity: OrchestrationThreadActivity) => {
    const beat = beatActivityFromThreadActivity(activity);
    if (beat === null) return Effect.void;
    return liveStatus.noteActivity({
      taskId: task.taskId,
      parentThreadId: task.parentThreadId,
      activity: beat,
    });
  };

  const onActivity = Effect.fn("DelegationSupervisor.onActivity")(function* (
    task: DeveloperTask,
    event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  ) {
    const activity = event.payload.activity;
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Readonly<Record<string, unknown>>)
        : {};
    // Beats are independent of the approval/question state machine.
    yield* publishBeat(task, activity);
    switch (activity.kind) {
      case "approval.requested":
        return yield* onApprovalRequested(task, event.payload.threadId, payload);
      case "user-input.requested":
        return yield* onQuestion(task, payload);
      case "user-input.resolved":
        if (task.state === "waiting-on-bot" || task.state === "waiting-on-user") {
          return yield* setState(task.taskId, { state: "running" });
        }
        return;
      default:
        return;
    }
  });

  const handleEvent: DelegationSupervisor["Service"]["handleEvent"] = (event) => {
    if (event.type !== "thread.session-set" && event.type !== "thread.activity-appended") {
      return Effect.void;
    }
    const taskId = taskByWorkThread.get(event.payload.threadId);
    if (taskId === undefined) return Effect.void;
    return load(taskId).pipe(
      Effect.flatMap((found) => {
        if (Option.isNone(found) || isTerminalDeveloperTaskState(found.value.state)) {
          taskByWorkThread.delete(event.payload.threadId);
          return release(taskId);
        }
        return event.type === "thread.session-set"
          ? onSession(found.value, event)
          : onActivity(found.value, event);
      }),
      logAndContinue("developer task event handling failed"),
    );
  };

  // —— rehydration ——

  const rehydrate = Effect.gen(function* () {
    const all = yield* tasks.listAll().pipe(Effect.catchCause(failed));
    const open = all.filter((task) => !isTerminalDeveloperTaskState(task.state));
    if (open.length === 0) return;
    const live = new Set((yield* providers.listSessions()).map((session) => session.threadId));

    const unlaunched: Array<{ readonly task: DeveloperTask; readonly key: string }> = [];
    for (const task of open) {
      if (task.state === "awaiting-confirmation") continue;
      const key = yield* lockKeyForParent(task.parentThreadId);
      const workThreadId = task.workThreadId;
      if (workThreadId === null) {
        if (task.state === "queued") {
          unlaunched.push({ task, key });
        } else {
          lockKeyByTask.set(task.taskId, key);
          yield* failTask(task.taskId, "internal", "The developer never started.");
        }
        continue;
      }

      lockKeyByTask.set(task.taskId, key);
      taskByWorkThread.set(workThreadId, task.taskId);
      const shell = yield* snapshots
        .getThreadShellById(workThreadId)
        .pipe(Effect.catchCause(failed));
      const session = Option.isSome(shell) ? shell.value.session : null;
      const latestTurn = Option.isSome(shell) ? shell.value.latestTurn : null;
      if (session?.status === "ready" && latestTurn?.state === "completed") {
        // The turn finished while the server was down; nothing is left to wait for.
        lockHolders.set(key, task.taskId);
        yield* finishTurn(task, workThreadId);
        continue;
      }
      const sessionGone =
        session === null ||
        !live.has(workThreadId) ||
        session.status === "stopped" ||
        session.status === "error" ||
        session.status === "interrupted" ||
        session.status === "idle";
      if (sessionGone) {
        lockHolders.set(key, task.taskId);
        yield* failTask(
          task.taskId,
          "interrupted",
          "The server restarted while the developer was working.",
        );
        continue;
      }
      // Still alive: it keeps the worktree lock and its events are followed again.
      lockHolders.set(key, task.taskId);
      if (session.status === "running") turnSeenRunning.add(task.taskId);
    }

    for (const { task, key } of unlaunched) enqueue(key, task.taskId);
    for (const key of new Set(unlaunched.map((entry) => entry.key))) yield* promote(key);
  });

  const startReactor: DelegationSupervisor["Service"]["startReactor"] = Effect.fn(
    "DelegationSupervisor.startReactor",
  )(function* () {
    yield* liveStatus.startPublisher();
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      rehydrate.pipe(
        logAndContinue("developer task rehydration failed"),
        Effect.andThen(Stream.runForEach(events, handleEvent)),
      ),
    );
  });

  /** The bot behind a task, if it may still delegate (it can be archived or unbound mid-flight). */
  const requireDelegatingBot = (botId: BotId) =>
    Effect.gen(function* () {
      const bot = yield* bots
        .get(botId)
        .pipe(
          Effect.mapError(
            (error) =>
              new DelegationRejectedError({ reason: `Partner bot unavailable: ${error.message}` }),
          ),
        );
      if (bot.archivedAt !== null) {
        return yield* new DelegationRejectedError({
          reason: "I can't make changes myself; that partner is archived.",
        });
      }
      if (!bot.canDelegate) {
        return yield* new DelegationRejectedError({
          reason: "I can't make changes myself; ask Hybrid.",
        });
      }
      return bot;
    });

  // —— tool operations ——

  const start: DelegationSupervisor["Service"]["start"] = Effect.fn("DelegationSupervisor.start")(
    function* (input) {
      const bot = yield* requireDelegatingBot(input.botId);
      const taskId = DeveloperTaskId.make(`task-${yield* newUuid}`);
      const awaitConfirmation = requiresConfirmation({
        autonomy: bot.autonomy,
        scope: input.brief.scope,
        readOnly: bot.readOnly,
      });
      const developerEngine =
        bot.developerEngine === null
          ? null
          : yield* providers.getInstanceInfo(bot.developerEngine.instanceId).pipe(
              Effect.map((info) =>
                isHybridEngineDriver(info.driverKind) ? bot.developerEngine : null,
              ),
              Effect.orElseSucceed(() => null),
            );
      yield* dispatch({
        type: "developerTask.create",
        commandId: yield* commandId("developer-task-create", taskId),
        taskId,
        parentThreadId: input.thread.id,
        parentTurnId: input.parentTurnId,
        botId: input.botId,
        brief: input.brief,
        runtimeMode: resolveDeveloperRuntimeMode({
          autonomy: bot.autonomy,
          scope: input.brief.scope,
          readOnly: bot.readOnly,
        }),
        // The developer engine is the bot's own choice when set, else the thread's model.
        // HYBRID: an engine on a driver other than Claude/Codex falls back to the thread's.
        modelSelection: developerEngine ?? input.thread.modelSelection,
        createdAt: yield* now,
      });

      if (awaitConfirmation) {
        // No lock and no work thread until the user confirms (see `confirm`).
        yield* setState(taskId, { state: "awaiting-confirmation" });
        yield* appendPlanActivity(yield* requireTask(taskId), {
          kind: "developer-task.plan",
          summary: input.brief.goal,
        });
        return { taskId, status: "needs_confirmation" } as const;
      }

      // One writing task per worktree. The check and the claim are one synchronous step.
      const key = lockKeyOf(input.thread);
      lockKeyByTask.set(taskId, key);
      if (lockHolders.has(key)) {
        // The aggregate is created "queued"; it stays that way until the holder finishes.
        enqueue(key, taskId);
        return { taskId, status: "queued" } as const;
      }
      lockHolders.set(key, taskId);
      const task = yield* requireTask(taskId);
      yield* launch(task);
      return { taskId, status: "started" } as const;
    },
  );

  const check: DelegationSupervisor["Service"]["check"] = Effect.fn("DelegationSupervisor.check")(
    function* (taskId) {
      return yield* load(taskId);
    },
  );

  const message: DelegationSupervisor["Service"]["message"] = Effect.fn(
    "DelegationSupervisor.message",
  )(function* (input) {
    const task = yield* requireTask(input.taskId);
    if (isTerminalDeveloperTaskState(task.state)) {
      return yield* new DelegationRejectedError({
        reason: `The task is already ${task.state} and cannot be steered.`,
      });
    }
    if (task.workThreadId === null) {
      return yield* new DelegationRejectedError({
        reason: "The developer has not started working yet.",
      });
    }
    yield* dispatch({
      type: "developerTask.steer",
      commandId: yield* commandId("developer-task-steer", input.taskId),
      taskId: input.taskId,
      text: input.text,
      turnId: input.turnId,
      createdAt: yield* now,
    });
    // The steer record is bookkeeping; the developer only hears it as a message.
    yield* sendToDeveloper(task, task.workThreadId, {
      text: input.text,
      origin: "bot",
      commandId: yield* commandId("developer-task-steer-turn", input.taskId),
    });
  });

  const answer: DelegationSupervisor["Service"]["answer"] = Effect.fn(
    "DelegationSupervisor.answer",
  )(function* (input) {
    const task = yield* requireTask(input.taskId);
    const pending = task.pendingRequest;
    if (pending === null || pending.requestId !== input.requestId) {
      return yield* new DelegationRejectedError({
        reason: "The developer is not waiting on that request.",
      });
    }
    if (task.workThreadId === null) {
      return yield* new DelegationRejectedError({
        reason: "The developer has not started working yet.",
      });
    }
    const createdAt = yield* now;
    const respondTo = task.workThreadId;
    if (pending.kind === "approval") {
      if (input.decision === undefined) {
        return yield* new DelegationRejectedError({
          reason: "This request needs a decision: accept or decline.",
        });
      }
      // AUDIT §5.10: the bot cannot accept risky classes without a user grant (decision card).
      if (
        input.decision === "accept" &&
        input.userGranted !== true &&
        !botMayAcceptApprovalClass(pending.approvalClass)
      ) {
        return yield* new DelegationRejectedError({
          reason: "This needs the user's OK. Use ask_user.",
        });
      }
      yield* dispatch({
        type: "thread.approval.respond",
        commandId: yield* commandId("developer-task-approval", task.taskId),
        threadId: respondTo,
        requestId: pending.requestId,
        decision: input.decision,
        createdAt,
      });
    } else {
      if (input.answers === undefined) {
        return yield* new DelegationRejectedError({
          reason: "This request is a question and needs answers.",
        });
      }
      yield* dispatch({
        type: "thread.user-input.respond",
        commandId: yield* commandId("developer-task-answer", task.taskId),
        threadId: respondTo,
        requestId: pending.requestId,
        answers: input.answers,
        createdAt,
      });
    }
    // Answered: the developer carries on, and the pending ask is cleared with the state.
    yield* setState(task.taskId, { state: "running" });
  });

  const stop: DelegationSupervisor["Service"]["stop"] = Effect.fn("DelegationSupervisor.stop")(
    function* (taskId) {
      const task = yield* requireTask(taskId);
      yield* dispatch({
        type: "developerTask.cancel",
        commandId: yield* commandId("developer-task-cancel", taskId),
        taskId,
        createdAt: yield* now,
      });
      if (task.workThreadId !== null) {
        // Best effort: the task is already canceled whether or not the turn stops cleanly.
        yield* dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("developer-task-interrupt", taskId),
          threadId: task.workThreadId,
          createdAt: yield* now,
        }).pipe(logAndContinue("developer turn could not be interrupted"));
      }
      if (task.state === "awaiting-confirmation") {
        yield* appendPlanActivity(task, {
          kind: "developer-task.plan.resolved",
          decision: "declined",
        });
      }
      yield* retireDecisionCards(task);
      yield* release(taskId);
    },
  );

  const watch: DelegationSupervisor["Service"]["watch"] = Effect.fn("DelegationSupervisor.watch")(
    function* (parentThreadId) {
      // Attach live delivery before reading the snapshot so nothing published in between is lost.
      // The projection commits in the same transaction that publishes the event, so a re-read
      // after an event always sees it.
      const events = yield* engine.subscribeDomainEvents;
      const snapshot = yield* tasks
        .listByParentThreadId({ parentThreadId })
        .pipe(Effect.catchCause(failed));
      const owned = new Set<DeveloperTaskId>(snapshot.map((task) => task.taskId));
      const upserts = events.pipe(
        Stream.mapEffect((event): Effect.Effect<Option.Option<DeveloperTask>, DelegationError> => {
          switch (event.type) {
            case "developer-task.created":
              if (event.payload.task.parentThreadId !== parentThreadId) {
                return Effect.succeedNone;
              }
              owned.add(event.payload.task.taskId);
              return Effect.succeedSome(event.payload.task);
            case "developer-task.state-set":
            case "developer-task.steered":
              return owned.has(event.payload.taskId)
                ? load(event.payload.taskId)
                : Effect.succeedNone;
            default:
              return Effect.succeedNone;
          }
        }),
        Stream.filter(Option.isSome),
        Stream.map((task): DeveloperTaskListStreamEvent => ({
          _tag: "upserted",
          task: task.value,
        })),
      );
      return Stream.concat(Stream.succeed({ _tag: "snapshot", tasks: snapshot } as const), upserts);
    },
  );

  /** The first resolution each awaiting task got; later calls repeat it or are refused. */
  const resolutions = new Map<DeveloperTaskId, "confirm" | "decline" | "edit">();

  const resolutionPastTense = {
    confirm: "confirmed",
    decline: "declined",
    edit: "sent back for edits",
  } as const;

  /** Claims the task's one resolution. `true` when this call is the first. */
  const claimResolution = (
    taskId: DeveloperTaskId,
    decision: "confirm" | "decline" | "edit",
  ): Effect.Effect<boolean, DelegationRejectedError> => {
    const existing = resolutions.get(taskId);
    if (existing === undefined) {
      resolutions.set(taskId, decision);
      return Effect.succeed(true);
    }
    return existing === decision
      ? Effect.succeed(false)
      : Effect.fail(
          new DelegationRejectedError({
            reason: `The task was already ${resolutionPastTense[existing]}.`,
          }),
        );
  };

  const confirm: DelegationSupervisor["Service"]["confirm"] = Effect.fn(
    "DelegationSupervisor.confirm",
  )(function* (taskId) {
    if (!(yield* claimResolution(taskId, "confirm"))) return;
    yield* Effect.gen(function* () {
      const task = yield* requireTask(taskId);
      if (task.state !== "awaiting-confirmation") {
        if (isTerminalDeveloperTaskState(task.state)) {
          return yield* new DelegationRejectedError({
            reason: `The task is already ${task.state} and cannot be confirmed.`,
          });
        }
        // Queued, running, or waiting: it was confirmed before.
        return;
      }
      yield* requireDelegatingBot(task.botId);
      yield* appendPlanActivity(task, {
        kind: "developer-task.plan.resolved",
        decision: "confirmed",
      });
      const key = yield* lockKeyForParent(task.parentThreadId);
      if (lockHolders.has(key)) {
        yield* setState(taskId, { state: "queued" });
        enqueue(key, taskId);
        // The holder may have finished while the state was being written.
        if (!lockHolders.has(key)) yield* promote(key);
        return;
      }
      lockHolders.set(key, taskId);
      lockKeyByTask.set(taskId, key);
      yield* launch(task);
    }).pipe(Effect.onError(() => Effect.sync(() => resolutions.delete(taskId))));
  });

  /** Cancels an awaiting task for decline or edit: no work thread, plan card retired. */
  const cancelAwaiting = (
    taskId: DeveloperTaskId,
    decision: "decline" | "edit",
  ): Effect.Effect<void, DelegationError> =>
    Effect.gen(function* () {
      const task = yield* requireTask(taskId);
      if (task.state === "canceled") return;
      if (task.state !== "awaiting-confirmation") {
        return yield* new DelegationRejectedError({
          reason: `The task is already ${task.state} and cannot be ${decision === "edit" ? "edited" : "declined"}.`,
        });
      }
      yield* dispatch({
        type: "developerTask.cancel",
        commandId: yield* commandId(`developer-task-${decision}`, taskId),
        taskId,
        createdAt: yield* now,
      });
      yield* appendPlanActivity(task, {
        kind: "developer-task.plan.resolved",
        decision: decision === "edit" ? "edit" : "declined",
      });
      if (decision === "edit") {
        yield* wakes.notify({
          kind: "plan.edit",
          task,
          bodyLines: [
            "The user wants to edit this plan before any work starts. Nothing was started.",
          ],
        });
      }
    }).pipe(Effect.onError(() => Effect.sync(() => resolutions.delete(taskId))));

  const decline: DelegationSupervisor["Service"]["decline"] = Effect.fn(
    "DelegationSupervisor.decline",
  )(function* (taskId) {
    if (!(yield* claimResolution(taskId, "decline"))) return;
    yield* cancelAwaiting(taskId, "decline");
  });

  const edit: DelegationSupervisor["Service"]["edit"] = Effect.fn("DelegationSupervisor.edit")(
    function* (taskId) {
      if (!(yield* claimResolution(taskId, "edit"))) return;
      yield* cancelAwaiting(taskId, "edit");
    },
  );

  return {
    start,
    check,
    message,
    answer,
    stop,
    watch,
    confirm,
    decline,
    edit,
    startReactor,
    handleEvent,
  } satisfies DelegationSupervisor["Service"];
});

/** Builds the supervisor plus liveStatus. PartnerWakeScheduler is provided by the reactor layer. */
export const layer = Layer.effect(DelegationSupervisor, make).pipe(
  Layer.provideMerge(DeveloperTaskLiveStatus.layer),
);
