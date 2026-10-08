/**
 * HYBRID: PartnerDecisionService — decision cards for `ask_user` (AUDIT §5.7, §5.10).
 *
 * `ask` records a `partner-decision` activity on the partner's chat thread and, when the
 * card is about a parked developer task, moves the task to `waiting-on-user`. `resolve` is
 * the user's Approve / Deny / Always allow (or answer): it applies the decision, appends
 * `partner-decision.resolved`, and wakes the partner with a digest of what the user said.
 *
 * The activities are the source of truth; nothing is held in memory but a double-click guard.
 */
import {
  type BotId,
  CommandId,
  type DeveloperTask,
  type DeveloperTaskId,
  EventId,
  PARTNER_DECISION_ACTIVITY_KIND,
  PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
  PartnerDecisionCard,
  PartnerDecisionCardId,
  type PartnerDecisionKind,
  type PartnerDecisionResolveInput,
  type PartnerDecisionResolveDecision,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isTerminalDeveloperTaskState } from "../orchestration/developerTaskProjection.ts";
import {
  DelegationFailedError,
  DelegationRejectedError,
  DelegationSupervisor,
  type DelegationError,
} from "./DelegationSupervisor.ts";
import { PartnerWakeScheduler } from "./PartnerWakeScheduler.ts";
import { PolicyRulesStore } from "./policy/PolicyRulesStore.ts";

export interface PartnerDecisionAskInput {
  /** The partner's chat thread. */
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly kind: PartnerDecisionKind;
  readonly question: string;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly taskId?: DeveloperTaskId | undefined;
  readonly requestId?: string | undefined;
}

export class PartnerDecisionService extends Context.Service<
  PartnerDecisionService,
  {
    /**
     * Draws the card and returns its id. The bot's turn ends with the tool call; the user's
     * answer wakes the partner later.
     */
    readonly ask: (
      input: PartnerDecisionAskInput,
    ) => Effect.Effect<{ readonly cardId: PartnerDecisionCardId }, DelegationError>;
    readonly resolve: (input: PartnerDecisionResolveInput) => Effect.Effect<void, DelegationError>;
  }
>()("t3/bots/PartnerDecisionService") {}

const CARD_KINDS = [PARTNER_DECISION_ACTIVITY_KIND, PARTNER_DECISION_RESOLVED_ACTIVITY_KIND];
const decodeCard = Schema.decodeUnknownOption(PartnerDecisionCard);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** Cards on the thread with whether each was answered, oldest first. */
function cardsOf(
  thread: OrchestrationThread,
): ReadonlyArray<{ readonly card: PartnerDecisionCard; readonly resolved: boolean }> {
  const resolved = new Set<string>();
  for (const activity of thread.activities) {
    if (activity.kind !== PARTNER_DECISION_RESOLVED_ACTIVITY_KIND) continue;
    const cardId = record(activity.payload)?.cardId;
    if (typeof cardId === "string") resolved.add(cardId);
  }
  const cards: Array<{ card: PartnerDecisionCard; resolved: boolean }> = [];
  for (const activity of thread.activities) {
    if (activity.kind !== PARTNER_DECISION_ACTIVITY_KIND) continue;
    const card = decodeCard(activity.payload);
    if (Option.isSome(card)) {
      cards.push({ card: card.value, resolved: resolved.has(card.value.cardId) });
    }
  }
  return cards;
}

const reject = (reason: string) => new DelegationRejectedError({ reason });

const describeAnswer = (
  decision: PartnerDecisionResolveDecision,
  text: string | undefined,
): string => {
  switch (decision) {
    case "accept":
      return "approved";
    case "decline":
      return "declined";
    case "always_allow":
      return "approved, and always allowed for this project";
    case "answer":
      return `answered: ${text ?? ""}`;
  }
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const supervisor = yield* DelegationSupervisor;
  const wakes = yield* PartnerWakeScheduler;
  const rules = yield* PolicyRulesStore;
  const crypto = yield* Crypto.Crypto;

  /** Cards being resolved right now, so a double click answers once. */
  const resolving = new Set<string>();

  const failed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, DelegationFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new DelegationFailedError({ cause }));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newUuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(Effect.asVoid, Effect.catchCause(failed));

  const readThread = (threadId: ThreadId) =>
    snapshots
      .getThreadDetailById(threadId, { activityKinds: CARD_KINDS })
      .pipe(Effect.catchCause(failed));

  const appendActivity = (
    threadId: ThreadId,
    entry: {
      readonly key: string;
      readonly kind: string;
      readonly summary: string;
      readonly payload: unknown;
    },
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:${entry.kind}:${entry.key}`),
        threadId,
        activity: {
          id: EventId.make(yield* newUuid),
          tone: "info",
          kind: entry.kind,
          summary: entry.summary,
          payload: entry.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });

  const ask: PartnerDecisionService["Service"]["ask"] = Effect.fn("PartnerDecisionService.ask")(
    function* (input) {
      let task: DeveloperTask | undefined;
      if (input.taskId !== undefined) {
        const found = yield* supervisor.check(input.taskId);
        if (Option.isNone(found) || found.value.parentThreadId !== input.threadId) {
          return yield* reject("Task not found.");
        }
        task = found.value;
      }
      const pending = task?.pendingRequest ?? null;
      if (
        input.requestId !== undefined &&
        (task === undefined || pending === null || pending.requestId !== input.requestId)
      ) {
        return yield* reject("The developer is not waiting on that request.");
      }
      // An approval about a parked task defaults to the request it is parked on.
      const requestId =
        input.requestId ??
        (input.kind === "approval" && pending?.kind === "approval" ? pending.requestId : undefined);
      const approvalClass =
        input.kind === "approval" && pending !== null && pending.requestId === requestId
          ? pending.approvalClass
          : undefined;
      const matchDetail =
        input.kind === "approval" && pending !== null && pending.requestId === requestId
          ? pending.matchDetail
          : undefined;
      const alwaysAllow =
        input.kind === "approval" && pending !== null && pending.requestId === requestId
          ? pending.alwaysAllow
          : undefined;

      // A partner that asks twice about the same request gets the same card.
      if (requestId !== undefined && input.taskId !== undefined) {
        const thread = yield* readThread(input.threadId);
        const open = Option.isSome(thread)
          ? cardsOf(thread.value).find(
              (entry) =>
                !entry.resolved &&
                entry.card.taskId === input.taskId &&
                entry.card.requestId === requestId,
            )
          : undefined;
        if (open !== undefined) return { cardId: open.card.cardId };
      }

      const cardId = PartnerDecisionCardId.make(`decision-${yield* newUuid}`);
      const options = (input.options ?? []).map((option) => option.trim()).filter(Boolean);
      const card = {
        cardId,
        parentThreadId: input.threadId,
        botId: input.botId,
        kind: input.kind,
        question: input.question,
        ...(options.length > 0 ? { options } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(approvalClass !== undefined ? { approvalClass } : {}),
        ...(matchDetail !== undefined ? { matchDetail } : {}),
        ...(alwaysAllow !== undefined && alwaysAllow.length > 0 ? { alwaysAllow } : {}),
        createdAt: yield* now,
      };
      yield* appendActivity(input.threadId, {
        key: cardId,
        kind: PARTNER_DECISION_ACTIVITY_KIND,
        summary: input.question,
        payload: card,
      });

      // Only a developer that is actually blocked waits on the user; a running one keeps going.
      if (task !== undefined && task.state === "waiting-on-bot") {
        yield* dispatch({
          type: "developerTask.state.set",
          commandId: CommandId.make(`server:partner-decision-state:${cardId}`),
          taskId: task.taskId,
          state: "waiting-on-user",
          createdAt: yield* now,
        });
      }
      return { cardId };
    },
  );

  const resolve: PartnerDecisionService["Service"]["resolve"] = Effect.fn(
    "PartnerDecisionService.resolve",
  )(function* (input) {
    if (resolving.has(input.cardId)) {
      return yield* reject("That decision is already being answered.");
    }
    resolving.add(input.cardId);
    yield* Effect.gen(function* () {
      const thread = yield* readThread(input.parentThreadId);
      const entry = Option.isSome(thread)
        ? cardsOf(thread.value).find((candidate) => candidate.card.cardId === input.cardId)
        : undefined;
      if (entry === undefined) return yield* reject("Decision not found.");
      if (entry.resolved) return yield* reject("That decision was already answered.");
      const { card } = entry;

      const typed = (input.answerText ?? "").trim();
      const selected = (input.selectedOption ?? "").trim();
      const answerText = typed.length > 0 ? typed : selected;
      if (card.kind === "question") {
        if (input.decision === "always_allow") {
          return yield* reject("A question cannot be always allowed.");
        }
        if (input.decision === "accept" && answerText.length === 0) {
          return yield* reject("Say what you want to answer.");
        }
      }
      if (input.decision === "always_allow" && card.approvalClass === undefined) {
        return yield* reject("This request has no class to always allow.");
      }

      const parent = yield* snapshots
        .getThreadShellById(input.parentThreadId)
        .pipe(Effect.catchCause(failed));
      if (Option.isNone(parent)) return yield* reject("The partner thread is gone.");

      const task =
        card.taskId === undefined
          ? Option.none<DeveloperTask>()
          : yield* supervisor.check(card.taskId);

      if (input.decision === "always_allow") {
        const pendingRequest = Option.isSome(task) ? task.value.pendingRequest : null;
        const parked =
          pendingRequest !== null && pendingRequest.requestId === card.requestId
            ? pendingRequest
            : null;
        // HYBRID: one rule per normalized command part, never the whole chained line.
        const entries = card.alwaysAllow ?? parked?.alwaysAllow;
        if (entries !== undefined && entries.length > 0) {
          for (const entry of entries) {
            yield* rules.add({
              scope: "project",
              scopeId: parent.value.projectId,
              actionText: `Always allow ${entry.matchDetail}`,
              decision: "allow",
              approvalClass: entry.approvalClass,
              matchDetail: entry.matchDetail,
            });
          }
        } else {
          // Cards from before parts existed: the store re-normalizes the line on read.
          const structuredDetail = card.matchDetail ?? parked?.matchDetail;
          if (card.approvalClass === undefined || structuredDetail === undefined) {
            return yield* reject("This request has no command to always allow.");
          }
          yield* rules.add({
            scope: "project",
            scopeId: parent.value.projectId,
            actionText: parked?.summary ?? card.question,
            decision: "allow",
            approvalClass: card.approvalClass,
            matchDetail: structuredDetail,
          });
        }
      }

      // Only an approval parked on a developer request is answered here; a question goes back
      // to the partner, who knows which developer question it was and answers it.
      let applied: string | null = null;
      if (
        card.kind === "approval" &&
        card.taskId !== undefined &&
        card.requestId !== undefined &&
        Option.isSome(task) &&
        !isTerminalDeveloperTaskState(task.value.state)
      ) {
        applied = yield* supervisor
          .answer({
            taskId: card.taskId,
            requestId: card.requestId,
            decision: input.decision === "decline" ? "decline" : "accept",
            // User clicked Approve / Always allow — this is the only path past the bot accept guard.
            userGranted: true,
          })
          .pipe(
            Effect.as("the developer has your answer"),
            Effect.catchTag("DelegationRejectedError", (error) =>
              Effect.succeed(`the developer could not be answered: ${error.reason}`),
            ),
          );
      }

      const recorded: PartnerDecisionResolveDecision =
        card.kind === "question" && input.decision === "accept" ? "answer" : input.decision;
      yield* appendActivity(input.parentThreadId, {
        key: `${card.cardId}:resolved`,
        kind: PARTNER_DECISION_RESOLVED_ACTIVITY_KIND,
        summary: "Decision answered.",
        payload: {
          cardId: card.cardId,
          decision: recorded,
          ...(recorded === "answer" ? { answerText } : {}),
        },
      });

      yield* wakes.notify({
        kind: "decision.resolved",
        parentThreadId: input.parentThreadId,
        ...(Option.isSome(task) ? { task: task.value } : {}),
        bodyLines: [
          `card: ${card.cardId}`,
          `question: ${card.question}`,
          `user ${describeAnswer(recorded, answerText)}`,
          ...(card.requestId !== undefined ? [`request_id: ${card.requestId}`] : []),
          ...(applied !== null ? [`applied: ${applied}`] : []),
        ],
        ...(card.kind === "question" && card.taskId !== undefined
          ? {
              after:
                "The user answered your question. If the developer is waiting on it, relay the answer with answer_developer. Do not repeat this block.",
            }
          : {}),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => resolving.delete(input.cardId))));
  });

  return { ask, resolve } satisfies PartnerDecisionService["Service"];
});

export const layer = Layer.effect(PartnerDecisionService, make);
