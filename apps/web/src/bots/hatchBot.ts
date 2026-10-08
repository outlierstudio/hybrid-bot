/**
 * // HYBRID: Hatch client helpers — structured draft → BotUpsertInput.
 *
 * The interview itself is a server model turn (HatchService). Dead chip-based
 * planning (planHatch / type menus) was removed in Hatch v2 (AUDIT G2).
 */
import {
  ProviderDriverKind,
  type BotEngine,
  type BotUpsertInput,
  type HatchBotSpec,
  type ModelSelection,
} from "@t3tools/contracts";

const COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#86efac"] as const;

const HANDLE = /^[a-z][a-z0-9-]{1,31}$/;

export function handleFromName(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let base = words.join("-").replace(/^[^a-z]+/, "");
  if (base.length < 2) base = "bot";
  base = base.slice(0, 28).replace(/-+$/g, "");
  if (base.length < 2) base = "bot";

  let handle = base;
  let suffix = 2;
  while (taken.has(handle) || !HANDLE.test(handle)) {
    handle = `${base}-${suffix}`.slice(0, 32).replace(/-+$/g, "");
    suffix += 1;
    if (suffix > 50) {
      handle = `bot-${suffix}`;
    }
  }
  return handle;
}

export function colorForName(name: string): string {
  const total = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return COLORS[total % COLORS.length] ?? COLORS[0];
}

/** What the preview card edits. Autonomy is not here: hatched bots always start ask-first. */
export interface HatchDraft {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  /** 0 chill … 100 professional. */
  readonly tone: number;
  readonly sendsDeveloper: boolean;
}

function antiJobLines(sendsDeveloper: boolean, limits: string): string[] {
  const trimmed = limits.trim();
  return [
    sendsDeveloper
      ? "do not edit the project yourself. when code must change, use start_developer_task (or tell the user to switch to Engineer)."
      : "do not start code changes yourself; if the user needs edits, tell them Engineer can do it.",
    trimmed.length > 0 ? `never: ${trimmed}` : "never wander off the one job.",
  ];
}

/** Turn the model's structured spec into the draft the person edits. */
export function draftFromSpec(spec: HatchBotSpec): HatchDraft {
  const name = spec.name.trim();
  const purpose = (spec.purpose.trim() || spec.job.trim()).slice(0, 200);
  const base =
    spec.instructions.trim().length > 0
      ? spec.instructions.trim()
      : [`You are ${name}.`, `One job: ${spec.job.trim()}`].join("\n");
  return {
    name,
    purpose,
    instructions: [
      base,
      "",
      "Never:",
      ...antiJobLines(spec.sendsDeveloper, spec.limits).map((rule) => `- ${rule}`),
    ].join("\n"),
    tone: Math.min(100, Math.max(0, Math.round(spec.tone))),
    sendsDeveloper: spec.sendsDeveloper,
  };
}

/** The engine a hatched bot starts on: the model the person is already using. */
export function resolveHatchEngine(settings: {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly textGenerationModelSelection?: ModelSelection | null | undefined;
}): BotEngine | null {
  const selection = settings.defaultModelSelection ?? settings.textGenerationModelSelection ?? null;
  if (selection === null) return null;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options !== undefined ? { options: selection.options } : {}),
  };
}

export function composeHatchedBot(input: {
  readonly draft: HatchDraft;
  readonly engine: BotEngine | null;
  readonly takenHandles: ReadonlySet<string>;
}): BotUpsertInput {
  const { draft } = input;
  const name = draft.name.trim();
  return {
    handle: handleFromName(name, input.takenHandles),
    name,
    color: colorForName(name),
    instructions: draft.instructions.trim(),
    purpose: draft.purpose.trim(),
    tone: draft.tone,
    // Hatched bots ask first, whatever the model wrote. The person can loosen this in Settings.
    autonomy: "ask-first",
    canDelegate: draft.sendsDeveloper,
    partnerEngine: input.engine,
    developerEngine: null,
    // Legacy wire fields: not user-facing. runtimeMode follows ask-first.
    provider: ProviderDriverKind.make("codex"),
    model: null,
    runtimeMode: "approval-required",
    readOnly: !draft.sendsDeveloper,
    mcpServers: [],
  };
}
