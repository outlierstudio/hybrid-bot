/**
 * // HYBRID: pure helpers for BotSettings draft ↔ BotUpsertInput.
 */
import {
  ProviderDriverKind,
  type Bot,
  type BotAutonomy,
  type BotEngine,
  type BotRuntimeMode,
  type BotUpsertInput,
} from "@t3tools/contracts";

export const DEFAULT_BOT_COLOR = "#a78bfa";

export const AUTONOMY_LABELS: Record<BotAutonomy, string> = {
  "ask-first": "Ask first",
  "small-changes": "Small changes",
  full: "Full",
};

export const AUTONOMY_DESCRIPTIONS: Record<BotAutonomy, string> = {
  "ask-first": "Confirm before the developer changes code.",
  "small-changes": "Auto-accept routine edits; ask on larger or risky work.",
  full: "Developer may run with full access.",
};

export function isBotAutonomy(value: unknown): value is BotAutonomy {
  return value === "ask-first" || value === "small-changes" || value === "full";
}

/** Legacy runtimeMode follows autonomy so older paths stay coherent. */
export function runtimeModeForAutonomy(autonomy: BotAutonomy): BotRuntimeMode {
  switch (autonomy) {
    case "ask-first":
      return "approval-required";
    case "small-changes":
      return "auto-accept-edits";
    case "full":
      return "full-access";
  }
}

export function toneLabel(tone: number): string {
  if (tone < 34) return "chill";
  if (tone > 66) return "professional";
  return "balanced";
}

export function clampTone(tone: number): number {
  return Math.min(100, Math.max(0, Math.round(tone)));
}

export function emptyBotDraft(): BotUpsertInput {
  return {
    handle: "",
    name: "",
    color: DEFAULT_BOT_COLOR,
    instructions: "",
    purpose: "",
    tone: 50,
    autonomy: "ask-first",
    canDelegate: false,
    partnerEngine: null,
    developerEngine: null,
    provider: ProviderDriverKind.make("codex"),
    model: null,
    runtimeMode: "approval-required",
    readOnly: true,
    mcpServers: [],
  };
}

export function botToUpsertInput(bot: Bot, options?: { duplicate?: boolean }): BotUpsertInput {
  return {
    ...(options?.duplicate ? {} : { id: bot.id }),
    handle: options?.duplicate ? `${bot.handle}-copy`.slice(0, 32) : bot.handle,
    name: options?.duplicate ? `${bot.name} copy` : bot.name,
    color: bot.color,
    instructions: bot.instructions,
    purpose: bot.purpose,
    tone: bot.tone,
    autonomy: bot.autonomy,
    canDelegate: bot.canDelegate,
    partnerEngine: bot.partnerEngine,
    developerEngine: bot.developerEngine,
    provider: bot.provider,
    model: bot.model,
    runtimeMode: bot.runtimeMode,
    readOnly: bot.readOnly,
    mcpServers: [...bot.mcpServers],
  };
}

export function withAutonomy(draft: BotUpsertInput, autonomy: BotAutonomy): BotUpsertInput {
  return {
    ...draft,
    autonomy,
    runtimeMode: runtimeModeForAutonomy(autonomy),
  };
}

export function withCanDelegate(draft: BotUpsertInput, canDelegate: boolean): BotUpsertInput {
  return {
    ...draft,
    canDelegate,
    readOnly: !canDelegate,
  };
}

export function engineLabel(engine: BotEngine | null | undefined): string {
  if (!engine) return "Project default";
  return `${engine.model}`;
}
