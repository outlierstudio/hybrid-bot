import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DeveloperTask,
  DeveloperTaskCreateCommand,
  MessageOrigin,
  ThreadKind,
  ThreadPartnerSetCommand,
} from "./index.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTask = Schema.decodeUnknownSync(DeveloperTask);
const decodeCreate = Schema.decodeUnknownSync(DeveloperTaskCreateCommand);
const decodePartnerSet = Schema.decodeUnknownSync(ThreadPartnerSetCommand);
const decodeOrigin = Schema.decodeUnknownSync(MessageOrigin);
const decodeKind = Schema.decodeUnknownSync(ThreadKind);

describe("developerTask contracts", () => {
  it("decodes a developer task record", () => {
    const task = decodeTask({
      taskId: "task_1",
      parentThreadId: "thread_parent",
      parentTurnId: "turn_1",
      workThreadId: null,
      workTurnIds: [],
      botId: "builtin-engineer",
      brief: {
        goal: "Fix the button",
        context: "z-index",
        constraints: "",
        acceptance: "tests pass",
        scope: "small",
      },
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("inst_1"),
        model: "gpt-5",
      },
      state: "queued",
      pendingRequest: null,
      result: null,
      failure: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    });
    expect(task.state).toBe("queued");
    expect(task.brief.scope).toBe("small");
  });

  it("decodes developerTask.create and thread.partner.set", () => {
    const create = decodeCreate({
      type: "developerTask.create",
      commandId: "cmd_1",
      taskId: "task_1",
      parentThreadId: "thread_parent",
      parentTurnId: "turn_1",
      botId: "builtin-engineer",
      brief: {
        goal: "Fix the button",
        context: "",
        constraints: "",
        acceptance: "",
        scope: "medium",
      },
      runtimeMode: "approval-required",
      modelSelection: {
        instanceId: ProviderInstanceId.make("inst_1"),
        model: "gpt-5",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(create.type).toBe("developerTask.create");

    const partner = decodePartnerSet({
      type: "thread.partner.set",
      commandId: "cmd_2",
      threadId: "thread_1",
      partnerBotId: "builtin-engineer",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(partner.partnerBotId).toBe("builtin-engineer");
  });

  it("accepts message origin and thread kind literals", () => {
    expect(decodeOrigin("system-wake")).toBe("system-wake");
    expect(decodeKind("work")).toBe("work");
  });
});
