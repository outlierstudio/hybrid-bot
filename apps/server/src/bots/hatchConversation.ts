/**
 * Hatch interview prompt + mapping for the picked-provider text generation path.
 */
import type { HatchTurnInput, HatchTurnResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface HatchSpec {
  readonly name: string;
  readonly job: string;
  readonly sendsDeveloper: boolean;
  readonly limits: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly tone: number;
}

export function hatchSystemPrompt(): string {
  return [
    "You are Hatch. You create a bot by talking. You are not a form and not a menu.",
    "Do not ask for a name first. Read the job from what they already said.",
    "Do not offer research, review, plan, or build. Do not offer chips or a list of types.",
    "Ask at most one question, as a sentence, only when you cannot write the bot yet.",
    "When the job is clear and you have a name (theirs, or one you recommend and they accept), set ready true.",
    "If they did not name it, ask for a name only after the job is clear.",
    'Reply with JSON only: {"say":"...","ready":false,"name":"","job":"","purpose":"","instructions":"","tone":50,"sendsDeveloper":false,"limits":""}.',
    "say is the sentence they read. When ready is true, name and job are filled, sendsDeveloper is true only if this bot should change the project, and limits is a short never-rule or empty.",
    'When ready is true also write the draft they will edit: purpose is one line shown under the bot\'s face, instructions is how the bot works written in second person ("You ..."), and tone is 0 (chill) to 100 (professional).',
    "Do not choose a model, engine, or autonomy. Those are set for them.",
  ].join("\n");
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = extractJsonObject(value);
    return parsed === null ? null : asRecord(parsed);
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.say === "string") return record;
  if (
    typeof record.result === "string" ||
    (record.result !== null && typeof record.result === "object")
  ) {
    return asRecord(record.result);
  }
  return record;
}

export function parseHatchDecision(value: unknown): { say: string; spec: HatchSpec | null } | null {
  const record = asRecord(value);
  if (record === null) return null;
  const say = typeof record.say === "string" ? record.say.trim() : "";
  if (say.length === 0) return null;
  if (record.ready !== true) return { say, spec: null };
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const job = typeof record.job === "string" ? record.job.trim() : "";
  const purposeText = typeof record.purpose === "string" ? record.purpose.trim() : "";
  const jobText = job.length >= 2 ? job : purposeText;
  if (name.length < 2 || jobText.length < 2) return { say, spec: null };
  const rawTone =
    typeof record.tone === "number" && Number.isFinite(record.tone) ? record.tone : 50;
  return {
    say,
    spec: {
      name,
      job: jobText,
      sendsDeveloper: record.sendsDeveloper === true,
      limits: typeof record.limits === "string" ? record.limits.trim() : "",
      purpose: purposeText.length > 0 ? purposeText : jobText,
      instructions: typeof record.instructions === "string" ? record.instructions.trim() : "",
      tone: Math.min(100, Math.max(0, Math.round(rawTone))),
    },
  };
}

export const HatchGenerationOutput = Schema.Struct({
  say: Schema.String,
  ready: Schema.Boolean,
  name: Schema.String,
  job: Schema.String,
  purpose: Schema.String,
  instructions: Schema.String,
  tone: Schema.Number,
  sendsDeveloper: Schema.Boolean,
  limits: Schema.String,
});
export type HatchGenerationOutput = typeof HatchGenerationOutput.Type;

export function buildHatchConversationPrompt(messages: HatchTurnInput["messages"]): string {
  const transcript = messages
    .map((message) => `${message.role === "user" ? "Person" : "Hatch"}: ${message.text.trim()}`)
    .filter((line) => !line.endsWith(":"))
    .join("\n");
  return [
    hatchSystemPrompt(),
    "",
    "Conversation so far:",
    transcript.length > 0 ? transcript : "(empty)",
    "",
    "Reply with the JSON object only. No markdown fence.",
  ].join("\n");
}

export function hatchResultFromGeneration(value: unknown): HatchTurnResult | null {
  const parsed = parseHatchDecision(value);
  if (parsed === null) return null;
  if (parsed.spec === null) {
    return { say: parsed.say, spec: null };
  }
  return {
    say: parsed.say,
    spec: { ...parsed.spec },
  };
}

export function buildHatchGenerationPrompt(input: HatchTurnInput): {
  readonly prompt: string;
  readonly outputSchema: typeof HatchGenerationOutput;
} {
  return {
    prompt: buildHatchConversationPrompt(input.messages),
    outputSchema: HatchGenerationOutput,
  };
}
