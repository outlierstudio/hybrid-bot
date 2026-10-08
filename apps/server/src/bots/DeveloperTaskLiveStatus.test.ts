import { DeveloperTaskId, ThreadId } from "@t3tools/contracts";
import { LIVE_STATUS_COALESCE_MS } from "@t3tools/shared/beatForActivity";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DeveloperTaskLiveStatus from "./DeveloperTaskLiveStatus.ts";
import { beatActivityFromThreadActivity } from "./DeveloperTaskLiveStatus.ts";

const TASK = DeveloperTaskId.make("task-1");
const PARENT = ThreadId.make("parent-1");

describe("beatActivityFromThreadActivity", () => {
  it("maps approval and tool activities", () => {
    assert.deepStrictEqual(
      beatActivityFromThreadActivity({
        id: "a1",
        kind: "approval.requested",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      } as never),
      { kind: "pending", pending: "approval" },
    );
    assert.deepStrictEqual(
      beatActivityFromThreadActivity({
        id: "a2",
        kind: "tool.started",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          itemType: "file_change",
          title: "Edit",
          status: "inProgress",
          data: { path: "src/a.ts" },
        },
      } as never),
      {
        kind: "tool",
        itemType: "file_change",
        title: "Edit",
        paths: ["src/a.ts"],
        status: "inProgress",
      },
    );
    assert.equal(
      beatActivityFromThreadActivity({
        id: "a3",
        kind: "tool.completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      } as never),
      null,
    );
  });
});

describe("DeveloperTaskLiveStatus", () => {
  it.effect("coalesces near-simultaneous updates into one published beat", () =>
    Effect.gen(function* () {
      const service = yield* DeveloperTaskLiveStatus.DeveloperTaskLiveStatusService;
      yield* service.startPublisher();

      const stream = yield* service.subscribe({ parentThreadId: PARENT });
      const fiber = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* service.noteActivity({
        taskId: TASK,
        parentThreadId: PARENT,
        activity: {
          kind: "tool",
          itemType: "file_change",
          paths: ["a.ts"],
          status: "inProgress",
        },
      });
      yield* service.noteActivity({
        taskId: TASK,
        parentThreadId: PARENT,
        activity: {
          kind: "tool",
          itemType: "file_change",
          paths: ["a.ts", "b.ts", "c.ts"],
          status: "inProgress",
        },
      });

      // Nothing published yet — get still shows the pre-flush null liveStatus.
      assert.equal(service.get(TASK)?.liveStatus ?? null, null);

      yield* TestClock.adjust(Duration.millis(LIVE_STATUS_COALESCE_MS));
      const events = [...(yield* Fiber.join(fiber))];
      assert.equal(events[0]?._tag, "snapshot");
      assert.equal(events[1]?._tag, "updated");
      if (events[1]?._tag === "updated") {
        assert.equal(events[1].status.liveStatus, "Editing 3 files");
      }
      assert.equal(service.get(TASK)?.liveStatus, "Editing 3 files");
    }).pipe(Effect.scoped, Effect.provide(DeveloperTaskLiveStatus.layer)),
  );

  it.effect("clear removes the task", () =>
    Effect.gen(function* () {
      const service = yield* DeveloperTaskLiveStatus.DeveloperTaskLiveStatusService;
      yield* service.startPublisher();
      yield* service.noteActivity({
        taskId: TASK,
        parentThreadId: PARENT,
        activity: { kind: "pending", pending: "approval" },
      });
      yield* TestClock.adjust(Duration.millis(LIVE_STATUS_COALESCE_MS));
      assert.equal(service.get(TASK)?.liveStatus, "Waiting on your OK");
      yield* service.clear(TASK);
      assert.equal(service.get(TASK), null);
    }).pipe(Effect.scoped, Effect.provide(DeveloperTaskLiveStatus.layer)),
  );
});
