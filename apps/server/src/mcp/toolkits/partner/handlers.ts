import {
  type BotId,
  type DeveloperTask,
  type DeveloperTaskId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DelegationFailedError, DelegationSupervisor } from "../../../bots/DelegationSupervisor.ts";
import { DeveloperTaskLiveStatusService } from "../../../bots/DeveloperTaskLiveStatus.ts";
import { PartnerDecisionService } from "../../../bots/PartnerDecisionService.ts";
import { isTerminalDeveloperTaskState } from "../../../orchestration/developerTaskProjection.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DeveloperTaskNotFoundError,
  PartnerNotAvailableError,
  PartnerThreadNotFoundError,
  PartnerToolkit,
  PartnerTurnRequiredError,
  type CheckDeveloperTaskResult,
} from "./tools.ts";

/** What the tools report from a task; exported so the shape is testable without a layer. */
export function checkResultOf(
  task: DeveloperTask,
  liveStatus: string | null = null,
): CheckDeveloperTaskResult {
  return {
    taskId: task.taskId,
    goal: task.brief.goal,
    state: task.state,
    pendingRequest: task.pendingRequest,
    result: task.result,
    failure: task.failure,
    liveStatus,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}

interface PartnerCaller {
  readonly thread: OrchestrationThreadShell;
  readonly botId: BotId;
}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const supervisor = yield* DelegationSupervisor;
  const liveStatus = yield* DeveloperTaskLiveStatusService;
  const decisions = yield* PartnerDecisionService;

  /**
   * Every tool starts here: the credential must carry the capability, and its thread
   * must be a chat thread with a partner bot. The capability is granted on those same
   * facts at session start; they are re-read because a partner can be unbound mid-session.
   */
  const requirePartner = Effect.fn("PartnerToolkit.requirePartner")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("partner");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new DelegationFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new PartnerThreadNotFoundError({ threadId: scope.threadId });
    }
    const botId = thread.value.partnerBotId;
    if ((thread.value.kind ?? "chat") !== "chat" || botId == null) {
      return yield* new PartnerNotAvailableError({ threadId: scope.threadId });
    }
    return { thread: thread.value, botId } satisfies PartnerCaller;
  });

  /** The task, only if this caller's thread started it and this caller's bot owns it. */
  const requireOwnedTask = Effect.fn("PartnerToolkit.requireOwnedTask")(function* (
    caller: PartnerCaller,
    taskId: DeveloperTaskId,
  ) {
    const task = yield* supervisor.check(taskId);
    if (
      Option.isNone(task) ||
      task.value.parentThreadId !== caller.thread.id ||
      task.value.botId !== caller.botId
    ) {
      return yield* new DeveloperTaskNotFoundError({ taskId });
    }
    return task.value;
  });

  const currentTurnId = (caller: PartnerCaller) => {
    const turn = caller.thread.latestTurn;
    return turn === null
      ? Effect.fail(new PartnerTurnRequiredError({}))
      : Effect.succeed(turn.turnId);
  };

  return PartnerToolkit.of({
    start_developer_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const parentTurnId = yield* currentTurnId(caller);
        return yield* supervisor.start({
          thread: caller.thread,
          parentTurnId,
          botId: caller.botId,
          brief: {
            goal: input.goal,
            context: input.context ?? "",
            constraints: input.constraints ?? "",
            acceptance: input.acceptance ?? "",
            scope: input.scope ?? "small",
          },
        });
      }),
    check_developer_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const task = yield* requireOwnedTask(caller, input.taskId);
        return checkResultOf(task, liveStatus.get(task.taskId)?.liveStatus ?? null);
      }),
    message_developer: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const task = yield* requireOwnedTask(caller, input.taskId);
        if (isTerminalDeveloperTaskState(task.state)) {
          return { status: "task_finished" as const };
        }
        const turnId = yield* currentTurnId(caller);
        yield* supervisor.message({ taskId: task.taskId, turnId, text: input.text });
        return { status: "sent" as const };
      }),
    answer_developer: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const task = yield* requireOwnedTask(caller, input.taskId);
        yield* supervisor.answer({
          taskId: task.taskId,
          requestId: input.requestId,
          ...(input.decision !== undefined ? { decision: input.decision } : {}),
          ...(input.answers !== undefined ? { answers: input.answers } : {}),
        });
        return { status: "answered" as const };
      }),
    stop_developer_task: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const task = yield* requireOwnedTask(caller, input.taskId);
        yield* supervisor.stop(task.taskId);
        return { status: "stopped" as const };
      }),
    ask_user: (input) =>
      Effect.gen(function* () {
        const caller = yield* requirePartner();
        const task =
          input.taskId === undefined ? undefined : yield* requireOwnedTask(caller, input.taskId);
        return yield* decisions.ask({
          threadId: caller.thread.id,
          botId: caller.botId,
          kind: input.kind,
          question: input.question,
          options: input.options,
          taskId: task?.taskId,
          requestId: input.requestId,
        });
      }),
  });
});

export const PartnerToolkitHandlersLive = PartnerToolkit.toLayer(make);
