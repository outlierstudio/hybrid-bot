import { describe, expect, it } from "vite-plus/test";
import { BotId, ProviderDriverKind, ProviderInstanceId, type Bot } from "@t3tools/contracts";
import {
  botToUpsertInput,
  clampTone,
  emptyBotDraft,
  runtimeModeForAutonomy,
  toneLabel,
  withAutonomy,
  withCanDelegate,
} from "./botSettingsLogic";

const sampleBot = {
  id: BotId.make("bot-1"),
  handle: "scout",
  name: "Scout",
  color: "#aabbcc",
  instructions: "You look around.",
  purpose: "Reads code.",
  tone: 40,
  autonomy: "ask-first",
  canDelegate: false,
  partnerEngine: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  developerEngine: null,
  provider: ProviderDriverKind.make("codex"),
  model: null,
  runtimeMode: "approval-required",
  readOnly: true,
  mcpServers: [],
  seedVersion: 0,
  userModified: false,
  archivedAt: null,
  builtIn: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies Bot;

describe("botSettingsLogic", () => {
  it("maps autonomy to legacy runtimeMode", () => {
    expect(runtimeModeForAutonomy("ask-first")).toBe("approval-required");
    expect(runtimeModeForAutonomy("small-changes")).toBe("auto-accept-edits");
    expect(runtimeModeForAutonomy("full")).toBe("full-access");
  });

  it("keeps draft autonomy and readOnly in sync", () => {
    const draft = withCanDelegate(withAutonomy(emptyBotDraft(), "full"), true);
    expect(draft.autonomy).toBe("full");
    expect(draft.runtimeMode).toBe("full-access");
    expect(draft.canDelegate).toBe(true);
    expect(draft.readOnly).toBe(false);
  });

  it("copies v2 fields into the upsert draft", () => {
    const draft = botToUpsertInput(sampleBot);
    expect(draft).toMatchObject({
      id: "bot-1",
      purpose: "Reads code.",
      tone: 40,
      autonomy: "ask-first",
      canDelegate: false,
      partnerEngine: { instanceId: "codex", model: "gpt-test" },
    });
    expect(botToUpsertInput(sampleBot, { duplicate: true }).id).toBeUndefined();
  });

  it("clamps tone and labels the slider", () => {
    expect(clampTone(140)).toBe(100);
    expect(toneLabel(10)).toBe("chill");
    expect(toneLabel(50)).toBe("balanced");
    expect(toneLabel(90)).toBe("professional");
  });
});
