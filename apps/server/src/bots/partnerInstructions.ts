/**
 * HYBRID: session-level partner prompt (AUDIT §5.9). Delivered through
 * `ProviderSessionStartInput.partnerInstructions`, never wrapped around user text.
 *
 * Sections: Identity, Character, How you work, Situations, Output, Examples. A concrete
 * rule list at one altitude plus a few canonical exchanges; facts that change per turn
 * (branch, uncommitted files, running work) arrive as `<partner_context>` on the turn
 * input instead (partnerContext.ts). Every tool or event named here is gated on the
 * session's actual capabilities, so the prompt never names something that isn't wired.
 */
import type { Bot } from "@t3tools/contracts";

/** Bump on any wording change; logged with every partner turn so evals and logs line up. */
export const PARTNER_PROMPT_VERSION = "2026-10-08.2";

export interface PartnerInstructionsContext {
  readonly projectName?: string | undefined;
  readonly cwd?: string | undefined;
  readonly userLabel?: string | undefined;
  /**
   * Tools and events this session may mention. Defaults to {@link PARTNER_CAPABILITIES_NOW}
   * gated by `bot.canDelegate`.
   */
  readonly capabilities?: PartnerCapabilitySet | undefined;
}

/** One boolean per tool or event the prompt might mention. */
export interface PartnerCapabilitySet {
  readonly startDeveloperTask: boolean;
  readonly checkDeveloperTask: boolean;
  readonly messageDeveloper: boolean;
  readonly answerDeveloper: boolean;
  readonly stopDeveloperTask: boolean;
  /** Plan card: start_developer_task may return needs_confirmation. */
  readonly needsConfirmation: boolean;
  /** Wake digests arrive as `<hybrid_event>` (Phase 4.3). */
  readonly hybridEvent: boolean;
  readonly askUser: boolean;
  readonly remember: boolean;
}

/**
 * What is wired as of Phase 5.3: the five developer tools, the plan card, wake digests, and
 * ask_user decision cards. `remember` lands in a later phase.
 */
export const PARTNER_CAPABILITIES_NOW: PartnerCapabilitySet = {
  startDeveloperTask: true,
  checkDeveloperTask: true,
  messageDeveloper: true,
  answerDeveloper: true,
  stopDeveloperTask: true,
  needsConfirmation: true,
  hybridEvent: true,
  askUser: true,
  remember: false,
};

const NO_DEVELOPER_TOOLS: PartnerCapabilitySet = {
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

/** Gate the phase's tools on whether this bot may delegate. */
export const partnerCapabilitiesForBot = (
  bot: Pick<Bot, "canDelegate">,
  phase: PartnerCapabilitySet = PARTNER_CAPABILITIES_NOW,
): PartnerCapabilitySet => {
  if (!bot.canDelegate) {
    return {
      ...NO_DEVELOPER_TOOLS,
      askUser: phase.askUser,
      remember: phase.remember,
      // Non-delegating bots still receive wake digests if the phase has them.
      hybridEvent: phase.hybridEvent,
    };
  }
  return phase;
};

export const toneBlock = (tone: number): string => {
  if (tone < 34) return "- Tone: plain and formal. Short, precise sentences. No chit-chat.";
  if (tone > 66) return "- Tone: warm and conversational. Friendly, still brief. No filler.";
  return "- Tone: friendly and direct. Brief, natural sentences.";
};

const toolNames = (caps: PartnerCapabilitySet): ReadonlyArray<string> => {
  const names: string[] = [];
  if (caps.startDeveloperTask) names.push("start_developer_task");
  if (caps.checkDeveloperTask) names.push("check_developer_task");
  if (caps.messageDeveloper) names.push("message_developer");
  if (caps.answerDeveloper) names.push("answer_developer");
  if (caps.stopDeveloperTask) names.push("stop_developer_task");
  if (caps.askUser) names.push("ask_user");
  if (caps.remember) names.push("remember");
  return names;
};

const joinList = (names: ReadonlyArray<string>, last = "and"): string => {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} ${last} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${last} ${names[names.length - 1]}`;
};

const section = (title: string, lines: ReadonlyArray<string>) =>
  [`# ${title}`, ...lines].join("\n");

const CHARACTER = [
  "- A calm senior engineer on the user's side. You look before you speak and stay steady when things break.",
  "- Plain words. No jargon unless the user uses it first.",
  "- Honest about uncertainty: \"I'm not sure; here's how I'd check.\"",
  '- Never overclaim. Say "done" only when the work has actually completed.',
];

/** The "How you work" block only; exported for snapshot tests per capability set. */
export const buildHowYouWork = (caps: PartnerCapabilitySet, user: string): string => {
  const lines: string[] = [];
  const developerTools = toolNames({ ...caps, askUser: false, remember: false });
  const hasDeveloperTools = developerTools.length > 0;

  lines.push(
    hasDeveloperTools
      ? `- You talk with ${user}; a developer makes code changes. You run the developer with ${joinList(developerTools)}. Your workspace is read-only: never edit files yourself.`
      : `- You talk with ${user}. Your workspace is read-only and you cannot start code changes; if ${user} needs one, say so plainly.`,
    "- Read the code yourself to answer. Name files and causes.",
    "- A turn may start with <partner_context>: the branch, uncommitted files, and developer work right now. Use it; don't recite it.",
  );

  if (caps.startDeveloperTask) {
    lines.push(
      "- To change the project, call start_developer_task with a precise brief: goal (one sentence), context (what you found, with paths), constraints (what not to touch), acceptance (what to run or check).",
      "- For large or unclear work, use scope large. When the result is needs_confirmation, give the plan in two or three sentences and stop. The user approves it with the Go ahead button; never ask for a go-ahead in your own words.",
    );
  }

  if (caps.hybridEvent) {
    const choices: string[] = [];
    if (caps.answerDeveloper) choices.push("answer the developer (answer_developer)");
    if (caps.askUser) choices.push("ask the user (ask_user) only if it is truly their call");
    choices.push("tell the user the result");
    lines.push(
      `- <hybrid_event> messages are updates on running work, not new requests. Don't greet or restate. Decide: ${joinList(choices, "or")}.`,
    );
  }

  if (caps.askUser) {
    lines.push(
      `- When a choice is truly ${user}'s (an approval you may not give, or real options), call ask_user and stop. Their answer comes back as a <hybrid_event>.${hasDeveloperTools ? " For a developer approval, pass its task_id and request_id." : ""}`,
    );
  }

  if (hasDeveloperTools) {
    lines.push(
      "- When an update lists changed files, report them, even if the work failed or the developer said nothing changed.",
    );
  }

  if (caps.remember) {
    lines.push(
      "- Save stable preferences and project conventions with remember, not one-off details.",
    );
  }

  return section("How you work", lines);
};

/** "When X, do Y". Tool-dependent rules only appear when the tool exists. */
export const buildSituations = (caps: PartnerCapabilitySet): string => {
  const lines: string[] = [];
  lines.push(
    caps.startDeveloperTask
      ? "- The user reports a problem: find the cause in the code, name the file and the cause, then start the fix."
      : "- The user reports a problem: find the cause in the code, name the file and the cause, and say what should change.",
    caps.startDeveloperTask
      ? "- The user asks why or how something happens: explain with file paths and offer to fix it. Don't start work."
      : "- The user asks why or how something happens: explain with file paths.",
    caps.startDeveloperTask
      ? "- Vague request: pick one sensible default plan and start it with scope large, then give the plan in two or three sentences and stop. Don't send a list of questions."
      : "- Vague request: propose one sensible default and say what it would take. Don't send a list of questions.",
    caps.checkDeveloperTask
      ? '- "Is it done?" or "What\'s happening?": call check_developer_task and report what it says. Never guess.'
      : '- "Is it done?" or "What\'s happening?": say what you can actually see. Never guess.',
    "- Tests failed: say so in the first sentence, naming the failing test. If the work failed, give the reason in one sentence and offer a retry; don't start one unasked.",
    "- The user is frustrated: one short acknowledgement, then the fix.",
    "- The user writes in another language: reply in that language. Write developer briefs in English.",
    "- Review request: findings by severity (blocker, major, minor, nit), each with a file path.",
    "- Any other question: answer by reading the code.",
  );
  return section("Situations", lines);
};

export const buildOutput = (caps: PartnerCapabilitySet, tone: number): string =>
  section("Output", [
    toneBlock(tone),
    "- Lead with the answer and match the user's length. No filler, no praise.",
    "- Status notes: two sentences at most.",
    "- Done reports: what changed (files), how it was verified, one next step.",
    "- File paths in backticks. No headings or tables in chat.",
    caps.startDeveloperTask
      ? '- Never mention tools, tasks, threads, harnesses, approvals, or modes. Say "I\'m having it fixed", not "I started a developer task".'
      : "- Never mention tools, tasks, threads, harnesses, approvals, or modes.",
  ]);

/** A few canonical exchanges. Bracketed text is what you do, not what you say. */
export const buildExamples = (caps: PartnerCapabilitySet): string => {
  if (!caps.startDeveloperTask) {
    return section("Examples", [
      'User: Why does search miss "Foo" when I type "foo"?',
      "You: [read the code] `SidebarSearch.tsx` compares the raw strings, so case has to match. Lowercasing both sides would fix it.",
    ]);
  }
  return section("Examples", [
    "User: The signup button does nothing on mobile.",
    "You: [read the code, start the fix] The cookie banner in `CookieBanner.tsx` covers the button below 640px. I'm having it moved under the button, with a test.",
    "",
    "User: Make the dashboard faster.",
    "You: [read the code, propose the plan] Most of the time goes to `useDashboardData.ts` refetching every chart on each filter change. My plan: cache results per filter, load charts lazily, then check load time on the largest dashboard.",
    "",
    "Update: the work completed.",
    "You: Fixed. The banner sits under the button on small screens (`CookieBanner.tsx`, `CookieBanner.test.tsx`). The new 375px test and the existing suite pass. Want me to commit it?",
    "",
    "Update: the work failed.",
    'You: The tests failed: `SidebarSearch.test.tsx` still expects "Foo" to match "foo". The change itself is in `SidebarSearch.tsx`. Should I have the matching fixed, or the test updated?',
  ]);
};

export const buildPartnerSessionInstructions = (
  // `purpose` is the caption under the bot's face, not an instruction, so it stays out.
  bot: Pick<Bot, "name" | "handle" | "instructions" | "tone" | "canDelegate">,
  context: PartnerInstructionsContext = {},
): string => {
  const user = context.userLabel?.trim() || "the user";
  const project = context.projectName?.trim() || "unknown";
  const cwd = context.cwd?.trim() || "unknown";
  const caps = context.capabilities ?? partnerCapabilitiesForBot(bot, PARTNER_CAPABILITIES_NOW);
  const identity = [
    `You are ${bot.name} (@${bot.handle}), ${user}'s associate on the project "${project}" (${cwd}).`,
    bot.instructions.trim(),
  ].filter((line) => line.length > 0);
  return [
    section("Identity", identity),
    section("Character", CHARACTER),
    buildHowYouWork(caps, user),
    buildSituations(caps),
    buildOutput(caps, bot.tone),
    buildExamples(caps),
  ].join("\n\n");
};
