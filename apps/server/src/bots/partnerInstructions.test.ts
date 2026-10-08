import { describe, expect, it } from "vite-plus/test";
import { BotId, ProviderDriverKind, type Bot } from "@t3tools/contracts";

import { BUILTIN_BOTS } from "./builtins.ts";
import {
  buildHowYouWork,
  buildPartnerSessionInstructions,
  PARTNER_CAPABILITIES_NOW,
  PARTNER_PROMPT_VERSION,
  partnerCapabilitiesForBot,
  type PartnerCapabilitySet,
} from "./partnerInstructions.ts";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: BotId.make("bot-ada"),
  handle: "ada",
  name: "Ada",
  color: "#a78bfa",
  instructions: "Prefer small diffs.",
  provider: ProviderDriverKind.make("codex"),
  model: null,
  runtimeMode: "full-access",
  readOnly: false,
  mcpServers: [],
  purpose: "Keeps the repo healthy.",
  tone: 50,
  autonomy: "small-changes",
  canDelegate: true,
  partnerEngine: null,
  developerEngine: null,
  seedVersion: 0,
  userModified: false,
  archivedAt: null,
  builtIn: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const ALL_OFF: PartnerCapabilitySet = {
  startDeveloperTask: false,
  checkDeveloperTask: false,
  messageDeveloper: false,
  answerDeveloper: false,
  stopDeveloperTask: false,
  needsConfirmation: false,
  hybridEvent: false,
  askUser: false,
  remember: false,
};

describe("buildPartnerSessionInstructions", () => {
  it("names the bot, project, cwd, user, and persona", () => {
    const text = buildPartnerSessionInstructions(bot(), {
      projectName: "hybrid",
      cwd: "/tmp/hybrid",
      userLabel: "Lee",
    });
    expect(text).toContain(
      'You are Ada (@ada), Lee\'s associate on the project "hybrid" (/tmp/hybrid).',
    );
    // Purpose is the caption under the face, not an instruction.
    expect(text).not.toContain("Keeps the repo healthy.");
    expect(text).toContain("Prefer small diffs.");
    expect(text).toContain("Your workspace is read-only");
  });

  it("does not carry the legacy harness-order contract", () => {
    const text = buildPartnerSessionInstructions(bot(), { projectName: "p", cwd: "/p" });
    expect(text).not.toContain("<harness-order>");
    expect(text).not.toContain("bot-instructions");
  });

  it("falls back to neutral labels", () => {
    const text = buildPartnerSessionInstructions(bot({ purpose: "" }));
    expect(text).toContain("the user's associate");
    expect(text).toContain('"unknown" (unknown)');
  });

  it("adapts the voice block to tone", () => {
    expect(buildPartnerSessionInstructions(bot({ tone: 10 }))).toContain("plain and formal");
    expect(buildPartnerSessionInstructions(bot({ tone: 90 }))).toContain("warm and conversational");
    expect(buildPartnerSessionInstructions(bot({ tone: 50 }))).toContain("friendly and direct");
  });

  it("omits future tools until their capabilities are on", () => {
    const text = buildPartnerSessionInstructions(bot(), {
      projectName: "hybrid",
      cwd: "/tmp/hybrid",
      userLabel: "Lee",
    });
    expect(text).toContain("call ask_user and stop");
    expect(text).not.toContain("remember");
    const without = buildPartnerSessionInstructions(bot(), {
      capabilities: { ...PARTNER_CAPABILITIES_NOW, askUser: false },
    });
    expect(without).not.toContain("ask_user");
    expect(text).toContain("<hybrid_event>");
    expect(text).toContain("needs_confirmation");
    expect(text).toContain("start_developer_task");
    expect(text).toContain("use scope large");
    expect(text).toContain("report them, even if the work failed");
    expect(text).toContain("call check_developer_task and report what it says");
  });

  it("gates developer tools when the bot cannot delegate", () => {
    const text = buildPartnerSessionInstructions(bot({ canDelegate: false }), {
      projectName: "hybrid",
      cwd: "/tmp/hybrid",
      userLabel: "Lee",
    });
    expect(text).not.toContain("start_developer_task");
    expect(text).not.toContain("needs_confirmation");
    expect(text).not.toContain("check_developer_task");
    expect(text).toContain("cannot start code changes");
    expect(text).toContain("Never guess.");
    // The no-delegation examples don't show starting work.
    expect(text).not.toContain("start the fix]");
  });
});

describe("Hybrid's prompt", () => {
  const hybrid = BUILTIN_BOTS[0]!;
  const text = buildPartnerSessionInstructions(hybrid, {
    projectName: "hybrid",
    cwd: "/work/hybrid",
    userLabel: "Lee",
  });

  it("is the whole prompt, verbatim", () => {
    expect(PARTNER_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(text).toMatchSnapshot();
  });

  it("has the six sections, in order", () => {
    const headings = text.split("\n").filter((line) => line.startsWith("# "));
    expect(headings).toEqual([
      "# Identity",
      "# Character",
      "# How you work",
      "# Situations",
      "# Output",
      "# Examples",
    ]);
  });

  it("stays under about 6k characters", () => {
    expect(text.length).toBeLessThan(6000);
  });

  it("covers every Situation rule", () => {
    for (const rule of [
      "The user reports a problem: find the cause in the code, name the file and the cause, then start the fix.",
      "The user asks why or how something happens: explain with file paths and offer to fix it. Don't start work.",
      "Vague request: pick one sensible default plan and start it with scope large",
      '"Is it done?"',
      "Tests failed: say so in the first sentence",
      "frustrated: one short acknowledgement",
      "another language: reply in that language. Write developer briefs in English.",
      "Review request: findings by severity",
      "Any other question: answer by reading the code.",
    ]) {
      expect(text).toContain(rule);
    }
  });

  it("leaves the go-ahead to the plan card, never to prose", () => {
    expect(text).not.toContain("Go ahead?");
    expect(text).not.toContain("ask to go ahead");
    expect(text).toContain("approves it with the Go ahead button");
  });

  it("Identity is just the name and project line; Hybrid's job lives in the later sections", () => {
    const identity = text.slice(0, text.indexOf("# Character")).trim().split("\n");
    expect(identity).toEqual([
      "# Identity",
      'You are Hybrid (@hybrid), Lee\'s associate on the project "hybrid" (/work/hybrid).',
    ]);
    // Plan-card and delegation rules appear once, in How you work / Situations.
    expect(text.match(/scope large/g)?.length).toBe(2);
  });

  it("examples never name a tool in what Hybrid says", () => {
    const said = text
      .slice(text.indexOf("# Examples"))
      .split("\n")
      .filter((line) => line.startsWith("You:"))
      .map((line) => line.replace(/^You: \[[^\]]*\]/, ""));
    expect(said.length).toBeGreaterThanOrEqual(3);
    for (const line of said) expect(line).not.toMatch(/_developer|_task|ask_user|tool|thread/);
  });
});

describe("partnerCapabilitiesForBot", () => {
  it("keeps the phase set for a delegating bot", () => {
    expect(partnerCapabilitiesForBot(bot())).toEqual(PARTNER_CAPABILITIES_NOW);
  });

  it("strips developer tools for a non-delegating bot", () => {
    expect(partnerCapabilitiesForBot(bot({ canDelegate: false }))).toEqual({
      ...ALL_OFF,
      askUser: true,
      remember: false,
      // Wake digests still apply if the phase has them.
      hybridEvent: true,
    });
  });
});

describe("buildHowYouWork snapshots per capability set", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly caps: PartnerCapabilitySet }> = [
    { name: "phase-5-now", caps: PARTNER_CAPABILITIES_NOW },
    {
      name: "with-hybrid-event",
      caps: { ...PARTNER_CAPABILITIES_NOW, hybridEvent: true },
    },
    {
      name: "with-ask-user-and-remember",
      caps: {
        ...PARTNER_CAPABILITIES_NOW,
        hybridEvent: true,
        askUser: true,
        remember: true,
      },
    },
    { name: "no-ask-user", caps: { ...PARTNER_CAPABILITIES_NOW, askUser: false } },
    { name: "no-developer-tools", caps: ALL_OFF },
    {
      name: "start-only-no-confirmation",
      caps: {
        ...ALL_OFF,
        startDeveloperTask: true,
        needsConfirmation: false,
      },
    },
  ];

  for (const { name, caps } of cases) {
    it(name, () => {
      expect(buildHowYouWork(caps, "Lee")).toMatchSnapshot();
    });
  }
});
