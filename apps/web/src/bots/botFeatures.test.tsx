import {
  BUILTIN_BOT_IDS,
  HYBRID_BOT_COLOR,
  HYBRID_BOT_ID,
  HYBRID_MULTI_BOT,
  type Bot,
  type BotSnapshot,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotBadge } from "./BotBadge";
import {
  BOT_FEATURES,
  botFeatures,
  isReadOnlyPartnerlessThread,
  pickableBots,
} from "./botFeatures";
import { PartnerFace } from "./PartnerFace";

const bot = (id: string, handle: string, archivedAt: string | null = null) =>
  ({ id, handle, name: handle, color: "#a78bfa", archivedAt }) as unknown as Bot;

const ALL = [
  bot(HYBRID_BOT_ID, "hybrid"),
  bot(BUILTIN_BOT_IDS.research, "research", "2026-10-08T00:00:00.000Z"),
  bot("bot-custom", "custom"),
];

describe("botFeatures", () => {
  it("ships with multi-bot off", () => {
    expect(HYBRID_MULTI_BOT).toBe(false);
    expect(BOT_FEATURES).toEqual(botFeatures(false, false));
  });

  it("off: hides Hatch, the composer chip, @ autocomplete, the bot list, and the talk-to pill", () => {
    expect(botFeatures(false, false)).toEqual({
      hatch: false,
      composerChip: false,
      mentionAutocomplete: false,
      botList: false,
      talkToMenu: false,
      developerDirect: false,
    });
  });

  it("on: shows all of them", () => {
    expect(botFeatures(true, true)).toEqual({
      hatch: true,
      composerChip: true,
      mentionAutocomplete: true,
      botList: true,
      talkToMenu: true,
      developerDirect: true,
    });
  });

  it("Developer directly alone brings the talk-to pill back", () => {
    expect(botFeatures(false, true).talkToMenu).toBe(true);
  });
});

describe("pickableBots", () => {
  it("off: only Hybrid can be picked or mentioned", () => {
    expect(pickableBots(ALL, false).map((entry) => entry.handle)).toEqual(["hybrid"]);
  });

  it("on: every live bot, never an archived one", () => {
    expect(pickableBots(ALL, true).map((entry) => entry.handle)).toEqual(["hybrid", "custom"]);
  });
});

describe("old threads", () => {
  it("a message with a Research snapshot still draws Research's face and name", () => {
    const research: BotSnapshot = { handle: "research", name: "Research", color: "#a78bfa" };
    const html = renderToStaticMarkup(<BotBadge snapshot={research} />);
    expect(html).toContain('data-bot-handle="research"');
    expect(html).toContain("Research");
    expect(html).toContain("#a78bfa");
  });
});

describe("PartnerFace", () => {
  it("draws Hybrid as the brand face: gradient and graphite eyes", () => {
    const html = renderToStaticMarkup(<PartnerFace color={HYBRID_BOT_COLOR} />);
    expect(html).toContain('stop-color="#F4F4F1"');
    expect(html).toContain('stop-color="#DCDCD7"');
    expect(html).toContain('fill="#1C1C1E"');
  });

  it("draws any other bot in its flat color", () => {
    const html = renderToStaticMarkup(<PartnerFace color="#a78bfa" />);
    expect(html).toContain('fill="#a78bfa"');
    expect(html).not.toContain("linearGradient");
  });
});

describe("isReadOnlyPartnerlessThread", () => {
  it("off: an old chat thread with no partner is read-only", () => {
    expect(isReadOnlyPartnerlessThread({ kind: "chat", partnerBotId: null }, false)).toBe(true);
    expect(isReadOnlyPartnerlessThread({ partnerBotId: null }, false)).toBe(true);
  });

  it("partner threads, work threads, and drafts are not", () => {
    expect(isReadOnlyPartnerlessThread({ kind: "chat", partnerBotId: HYBRID_BOT_ID }, false)).toBe(
      false,
    );
    expect(isReadOnlyPartnerlessThread({ kind: "work", partnerBotId: null }, false)).toBe(false);
    expect(isReadOnlyPartnerlessThread(null, false)).toBe(false);
  });

  it("on: nothing is read-only", () => {
    expect(isReadOnlyPartnerlessThread({ kind: "chat", partnerBotId: null }, true)).toBe(false);
  });
});
