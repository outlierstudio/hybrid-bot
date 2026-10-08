/**
 * HYBRID: wakes the partner bot on developer-task milestones (AUDIT §5.5).
 *
 * Dispatches an internal `thread.turn.start` (origin system-wake, visibility internal)
 * with a `<hybrid_event>` digest. Single-flight per partner thread; near-simultaneous
 * milestones coalesce into one digest. A user message that arrives while a wake is
 * pending takes the digest as a preamble instead of a separate turn.
 */
import { CommandId, type DeveloperTask, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

export type PartnerWakeKind =
  | "task.completed"
  | "task.failed"
  | "task.interrupted"
  | "approval.declined"
  | "approval.requested"
  | "decision.resolved"
  | "plan.edit";

export interface PartnerWakeMilestone {
  readonly kind: PartnerWakeKind;
  /** Absent for a decision that is not tied to a developer task. */
  readonly task?: DeveloperTask | undefined;
  /** The partner thread to wake; required when there is no task. */
  readonly parentThreadId?: ThreadId | undefined;
  /** Extra lines inside the hybrid_event body (already formatted). */
  readonly bodyLines?: ReadonlyArray<string> | undefined;
  /** Instruction line after the event block. */
  readonly after?: string | undefined;
}

interface ThreadWakeState {
  /** Digests waiting to send (coalesced). */
  pending: PartnerWakeMilestone[];
  /** A wake turn is currently running on this partner thread. */
  inFlight: boolean;
}

const formatElapsed = (task: DeveloperTask): string | undefined => {
  if (task.startedAt === null) return undefined;
  const start = Date.parse(task.startedAt);
  const end = Date.parse(task.completedAt ?? task.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const totalSeconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
};

const wakeThreadOf = (milestone: PartnerWakeMilestone): ThreadId | undefined =>
  milestone.task?.parentThreadId ?? milestone.parentThreadId;

const defaultAfter = (kind: PartnerWakeKind): string => {
  switch (kind) {
    case "task.completed":
      return "Tell the user what changed in plain words and offer the next step. Do not repeat this block.";
    case "task.failed":
    case "task.interrupted":
      return "Tell the user what failed in one or two sentences and propose a next step. Do not repeat this block.";
    case "approval.requested":
      // Prefer afterForApprovalRequested(class) from the notify site; this is the fallback.
      return "The developer is waiting on an approval your policy does not allow automatically. Decline it with answer_developer, or ask the user with ask_user (pass the task_id and request_id) and stop. Do not accept it yourself. Do not repeat this block.";
    case "decision.resolved":
      return "The user answered. Act on it and tell them what happens next in one sentence. Do not repeat this block.";
    case "plan.edit":
      return "Ask the user what they want changed in the plan if it is not already clear from the conversation, then revise the brief and call start_developer_task again. Do not start work before then. Do not repeat this block.";
    case "approval.declined":
      return "The developer was blocked. Decide whether to answer them, adjust the brief, or ask the user. Do not repeat this block.";
  }
};

const filesLine = (task: DeveloperTask): string | undefined => {
  const files = task.result?.filesChanged;
  if (files === undefined || files.length === 0) return undefined;
  return `files: ${files
    .slice(0, 8)
    .map((file) => `${file.path} (+${file.additions} -${file.deletions})`)
    .join(", ")}`;
};

/** Pure formatter — exported for tests. */
export function formatWakeDigest(milestones: ReadonlyArray<PartnerWakeMilestone>): string {
  if (milestones.length === 0) return "";
  const blocks = milestones.map((milestone) => {
    const { task, kind } = milestone;
    const elapsed = task === undefined ? undefined : formatElapsed(task);
    const attrs = [
      `kind="${kind}"`,
      ...(task !== undefined ? [`task="${task.taskId}"`] : []),
      ...(elapsed !== undefined ? [`elapsed="${elapsed}"`] : []),
    ].join(" ");
    const files = task === undefined ? undefined : filesLine(task);
    const lines = [
      ...(task !== undefined ? [`goal: ${task.brief.goal}`] : []),
      ...(milestone.bodyLines ?? []),
      ...(files !== undefined ? [files] : []),
    ];
    if (task !== undefined && kind === "task.completed" && task.result?.summary) {
      lines.splice(1, 0, `developer said: ${task.result.summary}`);
    }
    if (
      task !== undefined &&
      (kind === "task.failed" || kind === "task.interrupted") &&
      task.failure?.message
    ) {
      lines.splice(1, 0, `failure: ${task.failure.message}`);
    }
    const after = milestone.after ?? defaultAfter(kind);
    return `<hybrid_event ${attrs}>\n${lines.join("\n")}\n</hybrid_event>\n${after}`;
  });
  return blocks.join("\n\n");
}

export class PartnerWakeScheduler extends Context.Service<
  PartnerWakeScheduler,
  {
    /** Queue a milestone; may dispatch a wake turn immediately. */
    readonly notify: (milestone: PartnerWakeMilestone) => Effect.Effect<void>;
    /**
     * If digests are pending for this partner thread, consume them and return a preamble
     * to put in front of the user's message. Clears the pending buffer.
     */
    readonly takePendingPreamble: (parentThreadId: ThreadId) => Effect.Effect<string | null>;
    /** Call when a partner-thread turn settles so the next wake can fly. */
    readonly onPartnerTurnSettled: (parentThreadId: ThreadId) => Effect.Effect<void>;
    /** Watches partner-thread session settlement to release single-flight. */
    readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/PartnerWakeScheduler") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const byThread = new Map<ThreadId, ThreadWakeState>();

  const stateOf = (threadId: ThreadId): ThreadWakeState => {
    let state = byThread.get(threadId);
    if (!state) {
      state = { pending: [], inFlight: false };
      byThread.set(threadId, state);
    }
    return state;
  };

  const dispatchWake = (
    parentThreadId: ThreadId,
    milestones: ReadonlyArray<PartnerWakeMilestone>,
  ) =>
    Effect.gen(function* () {
      const text = formatWakeDigest(milestones);
      if (text.length === 0) return;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const firstTask = milestones.find((milestone) => milestone.task !== undefined)?.task;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:partner-wake:${parentThreadId}:${uuid}`),
        threadId: parentThreadId,
        message: {
          messageId: MessageId.make(uuid),
          role: "user",
          text,
          attachments: [],
          origin: "system-wake",
          visibility: "internal",
          ...(firstTask !== undefined ? { developerTaskId: firstTask.taskId } : {}),
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("partner wake turn could not be started", { cause }),
      ),
    );

  const tryFlush = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      const state = stateOf(parentThreadId);
      if (state.inFlight || state.pending.length === 0) return;

      const shell = yield* snapshots
        .getThreadShellById(parentThreadId)
        .pipe(Effect.catchCause(() => Effect.succeedNone));
      const turnState = Option.isSome(shell) ? shell.value.latestTurn?.state : undefined;
      // A live user/partner turn owns the thread; hold the digest until it settles or
      // takePendingPreamble merges it into the next user message.
      if (turnState === "running") {
        return;
      }

      const milestones = state.pending.splice(0, state.pending.length);
      state.inFlight = true;
      yield* dispatchWake(parentThreadId, milestones);
    });

  const notify: PartnerWakeScheduler["Service"]["notify"] = (milestone) =>
    Effect.gen(function* () {
      const parentThreadId = wakeThreadOf(milestone);
      if (parentThreadId === undefined) return;
      stateOf(parentThreadId).pending.push(milestone);
      yield* tryFlush(parentThreadId);
    });

  const takePendingPreamble: PartnerWakeScheduler["Service"]["takePendingPreamble"] = (
    parentThreadId,
  ) =>
    Effect.sync(() => {
      const state = stateOf(parentThreadId);
      if (state.pending.length === 0) return null;
      const milestones = state.pending.splice(0, state.pending.length);
      const digest = formatWakeDigest(milestones);
      return digest.length > 0 ? digest : null;
    });

  const onPartnerTurnSettled: PartnerWakeScheduler["Service"]["onPartnerTurnSettled"] = (
    parentThreadId,
  ) =>
    Effect.gen(function* () {
      const state = stateOf(parentThreadId);
      state.inFlight = false;
      yield* tryFlush(parentThreadId);
    });

  const startReactor: PartnerWakeScheduler["Service"]["startReactor"] = () =>
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) => {
          if (event.type !== "thread.session-set") return Effect.void;
          const state = byThread.get(event.payload.threadId);
          if (state === undefined || !state.inFlight) return Effect.void;
          const status = event.payload.session.status;
          if (
            status === "ready" ||
            status === "error" ||
            status === "interrupted" ||
            status === "stopped"
          ) {
            return onPartnerTurnSettled(event.payload.threadId);
          }
          return Effect.void;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("partner wake reactor failed", { cause }),
          ),
        ),
      );
    });

  return {
    notify,
    takePendingPreamble,
    onPartnerTurnSettled,
    startReactor,
  } satisfies PartnerWakeScheduler["Service"];
});

export const layer = Layer.effect(PartnerWakeScheduler, make);
