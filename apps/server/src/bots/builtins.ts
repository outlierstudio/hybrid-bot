/**
 * // HYBRID: built-in bot seed definitions.
 */
import {
  Bot,
  BotId,
  BUILTIN_BOT_IDS,
  HYBRID_BOT_COLOR,
  type BotAutonomy,
  type BotRuntimeMode,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";

const now = "1970-01-01T00:00:00.000Z";

/**
 * Bump when built-in seed fields change; untouched rows (user_modified=0) upgrade on boot.
 * 3: Engineer became Hybrid, the one associate; the specialists are archived.
 */
export const BUILTIN_SEED_VERSION = 3;

/** When seed 3 retired the specialists. Old threads still draw them from bot snapshots. */
export const SPECIALISTS_ARCHIVED_AT = "2026-10-08T00:00:00.000Z";

const seed = (input: {
  id: BotId;
  handle: string;
  name: string;
  color: string;
  instructions: string;
  purpose: string;
  runtimeMode: BotRuntimeMode;
  readOnly: boolean;
  autonomy: BotAutonomy;
  canDelegate: boolean;
  archivedAt?: string;
}): Bot => ({
  id: input.id,
  handle: input.handle,
  name: input.name,
  color: input.color,
  instructions: input.instructions,
  provider: ProviderDriverKind.make("codex"),
  model: null,
  runtimeMode: input.runtimeMode,
  readOnly: input.readOnly,
  mcpServers: [],
  purpose: input.purpose,
  tone: 50,
  autonomy: input.autonomy,
  canDelegate: input.canDelegate,
  partnerEngine: null,
  developerEngine: null,
  seedVersion: BUILTIN_SEED_VERSION,
  userModified: false,
  archivedAt: input.archivedAt ?? null,
  builtIn: true,
  createdAt: now,
  updatedAt: now,
});

export const BUILTIN_BOTS: ReadonlyArray<Bot> = [
  seed({
    id: BUILTIN_BOT_IDS.engineer,
    handle: "hybrid",
    name: "Hybrid",
    color: HYBRID_BOT_COLOR,
    purpose: "Your associate for this project.",
    runtimeMode: "full-access",
    readOnly: false,
    autonomy: "small-changes",
    canDelegate: true,
    // The partner prompt covers Hybrid's job; this stays empty for the user's own notes.
    instructions: "",
  }),
  seed({
    id: BUILTIN_BOT_IDS.research,
    archivedAt: SPECIALISTS_ARCHIVED_AT,
    handle: "research",
    name: "Research",
    color: "#a78bfa",
    purpose: "Read the codebase and explain what you find.",
    runtimeMode: "approval-required",
    readOnly: true,
    autonomy: "ask-first",
    canDelegate: false,
    instructions: [
      "You investigate the codebase and explain what you find, with file paths.",
      "Answer the user yourself when the question is about how the code works.",
      "If the user wants a change, tell them Engineer can do it (they can @engineer or switch the thread to Engineer).",
    ].join("\n"),
  }),
  seed({
    id: BUILTIN_BOT_IDS.reviewer,
    archivedAt: SPECIALISTS_ARCHIVED_AT,
    handle: "reviewer",
    name: "Reviewer",
    color: "#f472b6",
    purpose: "Review diffs and list issues by severity.",
    runtimeMode: "approval-required",
    readOnly: true,
    autonomy: "ask-first",
    canDelegate: false,
    instructions: [
      "You review the current diff and list issues by severity: blocker, major, minor, nit.",
      "Tell the user the findings yourself.",
      "If the user wants this carried out, tell them Engineer can do it (they can @engineer or switch the thread to Engineer).",
    ].join("\n"),
  }),
  seed({
    id: BUILTIN_BOT_IDS.planner,
    archivedAt: SPECIALISTS_ARCHIVED_AT,
    handle: "planner",
    name: "Planner",
    color: "#38bdf8",
    purpose: "Write a concrete implementation plan.",
    runtimeMode: "approval-required",
    readOnly: true,
    autonomy: "ask-first",
    canDelegate: false,
    instructions: [
      "You write a concrete implementation plan: steps, risks, and how to test.",
      "Give the plan to the user.",
      "If the user wants this carried out, tell them Engineer can do it (they can @engineer or switch the thread to Engineer).",
    ].join("\n"),
  }),
];

export const builtinById = (id: BotId): Bot | undefined =>
  BUILTIN_BOTS.find((bot) => bot.id === id);
