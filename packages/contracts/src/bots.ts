/**
 * Hybrid bot definitions — reusable agent profiles summoned via @handle.
 *
 * // HYBRID: new contracts module for the bot layer.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const BotId = TrimmedNonEmptyString.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

/** Unique summon handle used as `@handle` in the composer. */
export const BotHandle = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/));
export type BotHandle = typeof BotHandle.Type;

export const BotColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type BotColor = typeof BotColor.Type;

/**
 * Mirror of `RuntimeMode` in orchestration.ts — kept local to avoid a circular
 * import (orchestration needs BotId/BotSnapshot from this module).
 */
export const BotRuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type BotRuntimeMode = typeof BotRuntimeMode.Type;

export const BotSnapshot = Schema.Struct({
  handle: BotHandle,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  color: BotColor,
});
export type BotSnapshot = typeof BotSnapshot.Type;

/** Partner or developer engine pick; null on the bot means project/thread default. */
export const BotEngine = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type BotEngine = typeof BotEngine.Type;

export const BotAutonomy = Schema.Literals(["ask-first", "small-changes", "full"]);
export type BotAutonomy = typeof BotAutonomy.Type;
export const DEFAULT_BOT_AUTONOMY: BotAutonomy = "small-changes";

/**
 * Bot v2: purpose/tone/autonomy/engines. Legacy fields (`provider`, `model`,
 * `runtimeMode`, `readOnly`, `mcpServers`) stay readable for one release.
 */
export const Bot = Schema.Struct({
  id: BotId,
  handle: BotHandle,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  color: BotColor,
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  // —— legacy (still required on the wire for one release) ——
  provider: ProviderDriverKind,
  /** null = use the thread's current model */
  model: Schema.NullOr(Schema.String),
  runtimeMode: BotRuntimeMode,
  readOnly: Schema.Boolean,
  /** Stored in MVP; not enforced at provider level yet */
  mcpServers: Schema.Array(Schema.String),
  // —— v2 ——
  purpose: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  tone: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
  autonomy: BotAutonomy.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_BOT_AUTONOMY))),
  canDelegate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  partnerEngine: Schema.NullOr(BotEngine).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  developerEngine: Schema.NullOr(BotEngine).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  seedVersion: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  userModified: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  builtIn: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

export const BotUpsertInput = Schema.Struct({
  id: Schema.optional(BotId),
  handle: BotHandle,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  color: BotColor,
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  provider: ProviderDriverKind,
  model: Schema.NullOr(Schema.String),
  runtimeMode: BotRuntimeMode,
  readOnly: Schema.Boolean,
  mcpServers: Schema.Array(Schema.String),
  purpose: Schema.optional(Schema.String),
  tone: Schema.optional(Schema.Number),
  autonomy: Schema.optional(BotAutonomy),
  canDelegate: Schema.optional(Schema.Boolean),
  partnerEngine: Schema.optional(Schema.NullOr(BotEngine)),
  developerEngine: Schema.optional(Schema.NullOr(BotEngine)),
});
export type BotUpsertInput = typeof BotUpsertInput.Type;

export const BotsListResult = Schema.Struct({
  bots: Schema.Array(Bot),
});
export type BotsListResult = typeof BotsListResult.Type;

export const BotDeleteInput = Schema.Struct({
  id: BotId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

/** Soft-archive (and restore). Preferred over delete in Settings. */
export const BotArchiveInput = Schema.Struct({
  id: BotId,
});
export type BotArchiveInput = typeof BotArchiveInput.Type;

export const BotResetBuiltInInput = Schema.Struct({
  id: BotId,
});
export type BotResetBuiltInInput = typeof BotResetBuiltInInput.Type;

export const BotError = Schema.Struct({
  code: Schema.Literals(["not-found", "duplicate-handle", "invalid", "provider-mismatch"]),
  message: TrimmedNonEmptyString,
});
export type BotError = typeof BotError.Type;

export const BotsUpdatedEvent = Schema.Struct({
  bots: Schema.Array(Bot),
});
export type BotsUpdatedEvent = typeof BotsUpdatedEvent.Type;

/** Built-in seed ids (stable across installs). */
export const BUILTIN_BOT_IDS = {
  engineer: BotId.make("builtin-engineer"),
  research: BotId.make("builtin-research"),
  reviewer: BotId.make("builtin-reviewer"),
  planner: BotId.make("builtin-planner"),
} as const;

/**
 * HYBRID: multi-bot (Hatch, custom bots, specialists, the bot picker). Off in this version:
 * the app ships one associate, Hybrid. The code stays behind this flag.
 */
export const HYBRID_MULTI_BOT: boolean = false;

/**
 * HYBRID: "Developer directly" (a thread with no partner: the plain T3 harness). Off: users
 * only ever talk to Hybrid; the server gives every new chat thread Hybrid, refuses to clear
 * the partner, and refuses turns on old partnerless chat threads until they continue with
 * Hybrid.
 */
export const HYBRID_DEVELOPER_DIRECT: boolean = false;

/**
 * HYBRID: the drivers Hybrid's partner and developer engines may use. Only these have a real
 * read-only partner profile and the partner MCP toolkit. With Developer directly on, any.
 */
export const HYBRID_ENGINE_DRIVERS: ReadonlyArray<string> = ["claudeAgent", "codex"];

export const isHybridEngineDriver = (
  driver: string,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): boolean => developerDirect || HYBRID_ENGINE_DRIVERS.includes(driver);

/** The one associate. It keeps the old Engineer id so existing threads and settings carry over. */
export const HYBRID_BOT_ID = BUILTIN_BOT_IDS.engineer;

/** Hybrid's face color (top of its gradient); PartnerFace draws the brand face for it. */
export const HYBRID_BOT_COLOR = "#F4F4F1";

/** One turn of the Hatch interview. The model writes the next sentence. */
export const HatchTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "hatch"]),
  text: Schema.String,
});
export type HatchTranscriptMessage = typeof HatchTranscriptMessage.Type;

/** Model the person already picked — Hatch talks on this provider path. */
export const HatchModelSelection = BotEngine;
export type HatchModelSelection = BotEngine;

export const HatchTurnInput = Schema.Struct({
  messages: Schema.Array(HatchTranscriptMessage),
  modelSelection: Schema.optionalKey(HatchModelSelection),
});
export type HatchTurnInput = typeof HatchTurnInput.Type;

/**
 * Structured hatch draft. The person edits it on a preview card before the bot is saved.
 * `job` is kept as the one-line job; `purpose`/`instructions`/`tone` are the v2 fields.
 * Autonomy and engine are never model output: the client defaults them (ask-first, the
 * person's current model).
 */
export const HatchBotSpec = Schema.Struct({
  name: Schema.String,
  job: Schema.String,
  sendsDeveloper: Schema.Boolean,
  limits: Schema.String,
  purpose: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  instructions: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  tone: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
});
export type HatchBotSpec = typeof HatchBotSpec.Type;

export const HatchTurnResult = Schema.Struct({
  say: Schema.String,
  spec: Schema.NullOr(HatchBotSpec),
});
export type HatchTurnResult = typeof HatchTurnResult.Type;
