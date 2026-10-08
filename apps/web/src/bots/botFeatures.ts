/**
 * // HYBRID: what the web shows for bots, from HYBRID_MULTI_BOT.
 *
 * With multi-bot off the app has one associate, Hybrid: no Hatch, no bot chip or
 * @handle autocomplete, no bot list in Settings. Old messages still draw any bot's
 * face from their snapshot.
 */
import {
  HYBRID_BOT_ID,
  HYBRID_DEVELOPER_DIRECT,
  HYBRID_MULTI_BOT,
  type Bot,
} from "@t3tools/contracts";

export interface BotFeatures {
  /** "New bot" entry points and the /new-bot route. */
  readonly hatch: boolean;
  /** The bot chip beside the composer. */
  readonly composerChip: boolean;
  /** Bots in the composer's @ menu. */
  readonly mentionAutocomplete: boolean;
  /** The bot list, create, archive, and import in Settings. */
  readonly botList: boolean;
  /** The composer's talk-to pill (pick a bot, or Developer directly). */
  readonly talkToMenu: boolean;
  /** Threads without a partner: the plain harness and its T3 chrome. */
  readonly developerDirect: boolean;
}

export const botFeatures = (
  multiBot: boolean = HYBRID_MULTI_BOT,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): BotFeatures => ({
  hatch: multiBot,
  composerChip: multiBot,
  mentionAutocomplete: multiBot,
  botList: multiBot,
  // Nothing to pick between with one bot and no Developer directly.
  talkToMenu: multiBot || developerDirect,
  developerDirect,
});

/**
 * An old chat thread with no partner (a plain T3 thread) opens read-only until the user
 * continues it with Hybrid. Work threads and drafts are never read-only for this reason.
 */
export function isReadOnlyPartnerlessThread(
  thread: {
    readonly kind?: string | undefined;
    readonly partnerBotId?: string | null | undefined;
  } | null,
  developerDirect: boolean = HYBRID_DEVELOPER_DIRECT,
): boolean {
  if (developerDirect || thread === null) return false;
  return (thread.kind ?? "chat") === "chat" && (thread.partnerBotId ?? null) === null;
}

export const BOT_FEATURES = botFeatures();

/** Bots a user can pick, mention, or bind: live ones, and only Hybrid with multi-bot off. */
export function pickableBots(
  allBots: ReadonlyArray<Bot>,
  multiBot: boolean = HYBRID_MULTI_BOT,
): ReadonlyArray<Bot> {
  return allBots.filter((bot) => bot.archivedAt === null && (multiBot || bot.id === HYBRID_BOT_ID));
}
