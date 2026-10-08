import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { Bot, BotHandle, BotUpsertInput, ThreadTurnStartCommand } from "./index.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeUpsert = Schema.decodeUnknownSync(BotUpsertInput);
const decodeHandle = Schema.decodeUnknownSync(BotHandle);
const decodeTurnStart = Schema.decodeUnknownSync(ThreadTurnStartCommand);

describe("Bot contracts", () => {
  it("decodes a valid bot", () => {
    const bot = decodeBot({
      id: "builtin-engineer",
      handle: "engineer",
      name: "Engineer",
      color: "#2dd4bf",
      instructions: "Ship it.",
      provider: ProviderDriverKind.make("codex"),
      model: null,
      runtimeMode: "full-access",
      readOnly: false,
      mcpServers: [],
      builtIn: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(bot.handle).toBe("engineer");
    expect(bot.model).toBeNull();
    // v2 defaults for payloads that omit the new fields
    expect(bot.purpose).toBe("");
    expect(bot.autonomy).toBe("small-changes");
    expect(bot.archivedAt).toBeNull();
  });

  it("rejects a bad handle", () => {
    expect(() => decodeHandle("Research")).toThrow();
    expect(() => decodeHandle("1bad")).toThrow();
    expect(() => decodeHandle("a")).toThrow();
    expect(decodeHandle("research")).toBe("research");
  });

  it("accepts upsert without id", () => {
    const input = decodeUpsert({
      handle: "docs",
      name: "Docs",
      color: "#a78bfa",
      instructions: "",
      provider: ProviderDriverKind.make("claudeAgent"),
      model: "sonnet",
      runtimeMode: "approval-required",
      readOnly: true,
      mcpServers: ["filesystem"],
    });
    expect(input.id).toBeUndefined();
    expect(input.model).toBe("sonnet");
  });

  it("still decodes thread.turn.start without botId", () => {
    const parsed = decodeTurnStart({
      type: "thread.turn.start",
      commandId: "cmd_1",
      threadId: "thread_1",
      message: {
        messageId: "msg_1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.botId).toBeUndefined();
  });

  it("decodes thread.turn.start with botId", () => {
    const parsed = decodeTurnStart({
      type: "thread.turn.start",
      commandId: "cmd_1",
      threadId: "thread_1",
      message: {
        messageId: "msg_1",
        role: "user",
        text: "summarize",
        attachments: [],
      },
      botId: "builtin-research",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.botId).toBe("builtin-research");
  });
});
