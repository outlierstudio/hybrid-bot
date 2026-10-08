import {
  ApprovalRequestId,
  DeveloperTaskId,
  type DeveloperTask,
  type DeveloperTaskListStreamEvent,
  type DeveloperTaskStatusStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import {
  canStopDeveloperTask,
  deriveDeveloperWorkCards,
  developerWorkElapsedMs,
  formatDeveloperTaskElapsed,
  reduceDeveloperTaskList,
  reduceDeveloperWorkLiveStatuses,
} from "./developerWork";

const task = (
  overrides: Omit<Partial<DeveloperTask>, "taskId"> & { taskId: string },
): DeveloperTask =>
  ({
    parentThreadId: "thread-parent",
    parentTurnId: "turn-1",
    workThreadId: "thread-work",
    workTurnIds: [],
    botId: "builtin-engineer",
    brief: {
      goal: "Fix the cookie banner",
      context: "",
      constraints: "",
      acceptance: "",
      scope: "small",
    },
    runtimeMode: "full-access",
    modelSelection: { instanceId: "inst-1", model: "gpt-5" },
    state: "running",
    pendingRequest: null,
    result: null,
    failure: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    startedAt: "2026-08-01T00:00:01.000Z",
    completedAt: null,
    ...overrides,
    taskId: DeveloperTaskId.make(overrides.taskId),
  }) as unknown as DeveloperTask;

const completedResult = {
  summary: "Moved the banner below the form.",
  filesChanged: [
    { path: "src/CookieBanner.tsx", additions: 6, deletions: 2 },
    { path: "src/CookieBanner.test.tsx", additions: 28, deletions: 0 },
  ],
  checks: [{ command: "pnpm test", outcome: "passed" as const }],
  checkpointTurnCount: 1,
};

describe("deriveDeveloperWorkCards", () => {
  it("builds the card from the task record", () => {
    const [card] = deriveDeveloperWorkCards([
      task({
        taskId: "t1",
        state: "completed",
        result: completedResult,
        completedAt: "2026-08-01T00:03:12.000Z",
      }),
    ]);
    expect(card).toMatchObject({
      taskId: "t1",
      goal: "Fix the cookie banner",
      state: "completed",
      workThreadId: "thread-work",
      additions: 34,
      deletions: 2,
      resultSummary: "Moved the banner below the form.",
      checks: [{ command: "pnpm test", outcome: "passed" }],
    });
    expect(card?.files.map((file) => file.path)).toEqual([
      "src/CookieBanner.tsx",
      "src/CookieBanner.test.tsx",
    ]);
  });

  it("leaves awaiting-confirmation to the plan card", () => {
    expect(
      deriveDeveloperWorkCards([task({ taskId: "t1", state: "awaiting-confirmation" })]),
    ).toEqual([]);
  });

  it("draws no card for a plan the user declined", () => {
    expect(
      deriveDeveloperWorkCards([
        task({
          taskId: "t1",
          state: "canceled",
          workThreadId: null,
          startedAt: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps a stopped task that did start", () => {
    const [card] = deriveDeveloperWorkCards([task({ taskId: "t1", state: "canceled" })]);
    expect(card?.state).toBe("canceled");
  });

  it.each(["queued", "running", "waiting-on-bot", "waiting-on-user"] as const)(
    "shows the live beat while %s",
    (state) => {
      const [card] = deriveDeveloperWorkCards([task({ taskId: "t1", state })], {
        t1: "Editing `CookieBanner.tsx`",
      });
      expect(card?.liveStatus).toBe("Editing `CookieBanner.tsx`");
      expect(canStopDeveloperTask(state)).toBe(true);
    },
  );

  it.each(["completed", "failed", "canceled"] as const)("drops a stale beat once %s", (state) => {
    const [card] = deriveDeveloperWorkCards([task({ taskId: "t1", state })], {
      t1: "Running tests",
    });
    expect(card?.liveStatus).toBeNull();
    expect(canStopDeveloperTask(state)).toBe(false);
  });

  it("carries the open ask and the failure message", () => {
    const cards = deriveDeveloperWorkCards([
      task({
        taskId: "t1",
        state: "waiting-on-user",
        pendingRequest: {
          requestId: ApprovalRequestId.make("req-1"),
          kind: "approval",
          summary: "Install left-pad",
        },
      }),
      task({
        taskId: "t2",
        state: "failed",
        failure: { code: "timeout", message: "It ran out of time." },
      }),
    ]);
    expect(cards[0]?.pendingSummary).toBe("Install left-pad");
    expect(cards[1]?.failureMessage).toBe("It ran out of time.");
  });

  it("reads files and checks from the task, never from message text", () => {
    const [card] = deriveDeveloperWorkCards([task({ taskId: "t1", state: "running" })]);
    expect(card?.files).toEqual([]);
    expect(card?.checks).toEqual([]);
    expect(card?.resultSummary).toBeNull();
  });
});

describe("elapsed time", () => {
  const base = { state: "running" as const, startedAt: "2026-08-01T00:00:00.000Z" };

  it("counts up to now while live", () => {
    expect(
      developerWorkElapsedMs({ ...base, completedAt: null }, Date.parse("2026-08-01T00:03:12Z")),
    ).toBe(192_000);
  });

  it("freezes at completion", () => {
    expect(
      developerWorkElapsedMs(
        { state: "completed", startedAt: base.startedAt, completedAt: "2026-08-01T00:01:00.000Z" },
        Date.parse("2026-08-02T00:00:00Z"),
      ),
    ).toBe(60_000);
  });

  it("has none before the task starts", () => {
    expect(
      developerWorkElapsedMs({ state: "queued", startedAt: null, completedAt: null }, Date.now()),
    ).toBeNull();
  });

  it("formats seconds, minutes, and hours", () => {
    expect(formatDeveloperTaskElapsed(45_000)).toBe("45s");
    expect(formatDeveloperTaskElapsed(192_000)).toBe("3m 12s");
    expect(formatDeveloperTaskElapsed(3_840_000)).toBe("1h 04m");
  });
});

describe("stream reducers", () => {
  const first = task({ taskId: "t1" });
  const second = task({ taskId: "t2" });

  it("replaces the list on a snapshot", () => {
    const event: DeveloperTaskListStreamEvent = { _tag: "snapshot", tasks: [first] };
    expect(reduceDeveloperTaskList([second], event)).toEqual([first]);
  });

  it("appends a new task and replaces a changed one in place", () => {
    const appended = reduceDeveloperTaskList([first], { _tag: "upserted", task: second });
    expect(appended.map((entry) => entry.taskId)).toEqual(["t1", "t2"]);
    const done = task({ taskId: "t1", state: "completed" });
    const replaced = reduceDeveloperTaskList(appended, { _tag: "upserted", task: done });
    expect(replaced).toEqual([done, second]);
    expect(replaced[1]).toBe(second);
  });

  it("tracks beats and drops a cleared one", () => {
    const snapshot: DeveloperTaskStatusStreamEvent = {
      _tag: "snapshot",
      statuses: [
        {
          taskId: "t1",
          parentThreadId: "thread-parent",
          liveStatus: "Running tests",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    } as unknown as DeveloperTaskStatusStreamEvent;
    const afterSnapshot = reduceDeveloperWorkLiveStatuses({}, snapshot);
    expect(afterSnapshot).toEqual({ t1: "Running tests" });
    const cleared = reduceDeveloperWorkLiveStatuses(afterSnapshot, {
      _tag: "updated",
      status: {
        taskId: "t1",
        parentThreadId: "thread-parent",
        liveStatus: null,
        updatedAt: "2026-08-01T00:00:05.000Z",
      },
    } as unknown as DeveloperTaskStatusStreamEvent);
    expect(cleared).toEqual({});
  });
});

describe("work card timeline row", () => {
  const rowsFor = (
    developerWork: ReturnType<typeof deriveDeveloperWorkCards>,
    timelineEntries: Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"] = [],
  ) =>
    deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      developerWork,
    });

  const userMessage = (id: string, createdAt: string) =>
    ({
      id,
      kind: "message",
      createdAt,
      message: {
        id,
        role: "user",
        text: id,
        turnId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    }) as unknown as Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"][number];

  it("renders one developer-work row per task", () => {
    const developerWork = deriveDeveloperWorkCards([task({ taskId: "t1" })]);
    expect(rowsFor(developerWork)).toEqual([
      {
        kind: "developer-work",
        id: "developer-work:t1",
        createdAt: "2026-08-01T00:00:00.000Z",
        work: developerWork[0],
      },
    ]);
  });

  it("closes out the turn that started the task, before the next user message", () => {
    const developerWork = deriveDeveloperWorkCards([task({ taskId: "t1" })]);
    const rows = rowsFor(developerWork, [
      userMessage("before", "2026-07-31T23:59:00.000Z"),
      userMessage("after", "2026-08-01T00:05:00.000Z"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["before", "developer-work:t1", "after"]);
  });

  it("goes last when no message follows", () => {
    const developerWork = deriveDeveloperWorkCards([task({ taskId: "t1" })]);
    const rows = rowsFor(developerWork, [userMessage("before", "2026-07-31T23:59:00.000Z")]);
    expect(rows.map((row) => row.id)).toEqual(["before", "developer-work:t1"]);
  });
});
