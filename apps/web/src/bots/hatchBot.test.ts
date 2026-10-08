import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type HatchBotSpec } from "@t3tools/contracts";
import { composeHatchedBot, draftFromSpec, handleFromName, resolveHatchEngine } from "./hatchBot";

const spec = (overrides: Partial<HatchBotSpec> = {}): HatchBotSpec => ({
  name: "Scout",
  job: "Find bugs before they ship.",
  sendsDeveloper: false,
  limits: "Do not rewrite tests to hide failures.",
  purpose: "",
  instructions: "",
  tone: 50,
  ...overrides,
});

describe("hatchBot", () => {
  it("turns a name into a free handle", () => {
    expect(handleFromName("Plan Buddy", new Set())).toBe("plan-buddy");
    expect(handleFromName("Plan Buddy", new Set(["plan-buddy"]))).toBe("plan-buddy-2");
    expect(handleFromName("!!", new Set())).toBe("bot");
  });

  it("builds an editable draft from the structured spec", () => {
    const draft = draftFromSpec(
      spec({ purpose: "Reads code.", instructions: "You read code.", tone: 140 }),
    );
    expect(draft.purpose).toBe("Reads code.");
    expect(draft.tone).toBe(100);
    expect(draft.instructions).toContain("You read code.");
    expect(draft.instructions).toContain("Do not rewrite tests to hide failures.");
    const fallback = draftFromSpec(spec());
    expect(fallback.purpose).toBe("Find bugs before they ship.");
    expect(fallback.instructions).toContain("Find bugs before they ship.");
  });

  it("hatches ask-first on the person's current model", () => {
    const engine = resolveHatchEngine({
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-current",
      },
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "other",
      },
    });
    expect(engine).toEqual({ instanceId: "codex", model: "gpt-current" });
    expect(resolveHatchEngine({})).toBeNull();
    const bot = composeHatchedBot({
      draft: draftFromSpec(spec()),
      engine,
      takenHandles: new Set(),
    });
    expect(bot.handle).toBe("scout");
    expect(bot.autonomy).toBe("ask-first");
    expect(bot.partnerEngine).toEqual({ instanceId: "codex", model: "gpt-current" });
    expect(bot.developerEngine).toBeNull();
    expect(bot.canDelegate).toBe(false);
    expect(bot.readOnly).toBe(true);
    expect(bot.runtimeMode).toBe("approval-required");
  });

  it("lets a bot send a developer when asked, still ask-first", () => {
    const bot = composeHatchedBot({
      draft: draftFromSpec(spec({ name: "Builder", sendsDeveloper: true, limits: "" })),
      engine: null,
      takenHandles: new Set(),
    });
    expect(bot.canDelegate).toBe(true);
    expect(bot.readOnly).toBe(false);
    expect(bot.autonomy).toBe("ask-first");
    expect(bot.runtimeMode).toBe("approval-required");
    expect(bot.partnerEngine).toBeNull();
    expect(bot.instructions).toContain("start_developer_task");
    expect(bot.instructions).not.toContain("harness order");
  });
});
