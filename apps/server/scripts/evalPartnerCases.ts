/**
 * Scripted partner-turn fixtures for `eval-partner.ts`.
 *
 * Observational only: expectations record what a well-behaved partner should do
 * with the current partnerInstructions. Do not retune prompts to pass these.
 */
import {
  BotId,
  DeveloperTaskId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type BotAutonomy,
  type DeveloperTask,
} from "@t3tools/contracts";

import { formatWakeDigest } from "../src/bots/PartnerWakeScheduler.ts";

export type PartnerEvalRole = "user" | "assistant" | "tool";

export interface PartnerEvalMessage {
  readonly role: PartnerEvalRole;
  readonly text: string;
  /** Present when role is "tool". */
  readonly toolName?: string | undefined;
}

export interface PartnerEvalBot {
  readonly canDelegate: boolean;
  readonly autonomy?: BotAutonomy | undefined;
  readonly name?: string | undefined;
  readonly handle?: string | undefined;
  readonly purpose?: string | undefined;
  readonly instructions?: string | undefined;
  readonly tone?: number | undefined;
}

export interface PartnerEvalExpect {
  /** Every listed tool must appear at least once across rounds. */
  readonly tools?: ReadonlyArray<string> | undefined;
  /** None of these tools may appear. */
  readonly toolsForbidden?: ReadonlyArray<string> | undefined;
  /** Case-insensitive substring checks on final assistant text. */
  readonly textIncludes?: ReadonlyArray<string> | undefined;
  readonly textExcludes?: ReadonlyArray<string> | undefined;
}

export interface PartnerEvalCase {
  readonly id: string;
  readonly description: string;
  readonly bot: PartnerEvalBot;
  readonly messages: ReadonlyArray<PartnerEvalMessage>;
  /**
   * When the model calls a listed tool, return this JSON as the tool result and
   * continue one more model round (needs_confirmation / mid-task flows).
   */
  readonly toolStubs?: Readonly<Record<string, unknown>> | undefined;
  readonly expect: PartnerEvalExpect;
}

const sampleTask = (overrides: Partial<DeveloperTask> = {}): DeveloperTask => ({
  taskId: DeveloperTaskId.make("dt_eval_running"),
  parentThreadId: ThreadId.make("parent-eval"),
  parentTurnId: TurnId.make("turn-eval"),
  workThreadId: ThreadId.make("work-eval"),
  workTurnIds: [TurnId.make("work-turn-1")],
  botId: BotId.make("bot-eval"),
  brief: {
    goal: "Make sidebar search case-insensitive",
    context: "apps/web/src/SidebarSearch.tsx",
    constraints: "Do not change routing.",
    acceptance: "pnpm test apps/web",
    scope: "small",
  },
  runtimeMode: "auto-accept-edits",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  state: "running",
  pendingRequest: null,
  result: null,
  failure: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  ...overrides,
});

const failedWake = formatWakeDigest([
  {
    kind: "task.failed",
    task: sampleTask({
      taskId: DeveloperTaskId.make("dt_eval_failed"),
      state: "failed",
      result: null,
      failure: {
        code: "developer-failed",
        message: "`pnpm test` failed: SidebarSearch.test.tsx expected 'Foo' to match 'foo'.",
      },
      completedAt: "2026-01-01T00:02:40.000Z",
      updatedAt: "2026-01-01T00:02:40.000Z",
    }),
  },
]);

const completedWake = formatWakeDigest([
  {
    kind: "task.completed",
    task: sampleTask({
      taskId: DeveloperTaskId.make("dt_eval_done"),
      state: "completed",
      result: {
        summary:
          "Sidebar search now lowercases both the query and labels before matching. Added a unit test. `pnpm test apps/web` passed.",
        filesChanged: [
          { path: "apps/web/src/SidebarSearch.tsx", additions: 8, deletions: 3 },
          { path: "apps/web/src/SidebarSearch.test.tsx", additions: 22, deletions: 0 },
        ],
        checks: [{ command: "pnpm test apps/web", outcome: "passed" }],
        checkpointTurnCount: 1,
      },
      failure: null,
      completedAt: "2026-01-01T00:03:12.000Z",
      updatedAt: "2026-01-01T00:03:12.000Z",
    }),
  },
]);

const DELEGATE: PartnerEvalBot = {
  canDelegate: true,
  autonomy: "small-changes",
  name: "Ada",
  handle: "ada",
  purpose: "Keeps the repo healthy.",
  instructions: "Prefer small diffs. Be specific about files.",
  tone: 50,
};

const ASK_FIRST: PartnerEvalBot = {
  ...DELEGATE,
  autonomy: "ask-first",
};

const READ_ONLY: PartnerEvalBot = {
  canDelegate: false,
  autonomy: "ask-first",
  name: "Research",
  handle: "research",
  purpose: "Reads the codebase and answers questions.",
  instructions: "You investigate and explain. You cannot change code.",
  tone: 40,
};

export const partnerEvalCases: ReadonlyArray<PartnerEvalCase> = [
  {
    id: "q-usebots",
    description: "Plain question about a symbol — no delegation",
    bot: DELEGATE,
    messages: [{ role: "user", text: "What does useBots do?" }],
    expect: {
      toolsForbidden: ["start_developer_task", "message_developer", "stop_developer_task"],
    },
  },
  {
    id: "q-explain-file",
    description: "Ask to explain a file — no delegation",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "Explain what apps/server/src/bots/partnerInstructions.ts is for, briefly.",
      },
    ],
    expect: {
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "q-how-works",
    description: "Short how-does-it-work question — no delegation",
    bot: DELEGATE,
    messages: [{ role: "user", text: "How does PartnerWakeScheduler decide when to wake me?" }],
    expect: {
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "q-short-status",
    description: "Status question with no running task — no start",
    bot: DELEGATE,
    messages: [{ role: "user", text: "Any work going on right now?" }],
    expect: {
      toolsForbidden: ["start_developer_task", "message_developer"],
    },
  },
  {
    id: "change-sidebar",
    description: "Clear change request — start developer task",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "Make the sidebar search case-insensitive in apps/web/src/SidebarSearch.tsx.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "change-short-fix",
    description: "Short imperative fix request — start",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "Fix the flaky case-insensitive test in SidebarSearch.test.tsx — have the developer make the search comparison lower-case both sides.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "change-long-ask",
    description: "Longer change ask with constraints — start",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: [
          "The cookie banner covers the signup button below 640px.",
          "Please lower the banner z-index in CookieBanner.tsx and add a 375px layout test.",
          "Do not touch the marketing pages.",
        ].join(" "),
      },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "confirm-yes-do-it",
    description: "User confirms a proposed plan — start after yes",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "The signup button does nothing on mobile. Can you fix it?",
      },
      {
        role: "assistant",
        text: "Looks like a z-index issue: the cookie banner covers the button below 640px. I would lower the banner and add a small-screen test. Say go ahead if you want that change.",
      },
      { role: "user", text: "yes, do it" },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "confirm-go-ahead",
    description: "User says go ahead after plan — start",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "Sidebar search should ignore case.",
      },
      {
        role: "assistant",
        text: "Plan: normalize query and label casing in SidebarSearch.tsx, add a unit test, leave routing alone. Waiting for your go-ahead.",
      },
      { role: "user", text: "go ahead" },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "needs-confirmation-ask-first",
    description:
      "ask-first autonomy: start returns needs_confirmation; explain plan, do not claim started",
    bot: ASK_FIRST,
    messages: [
      {
        role: "user",
        text: "Please make sidebar search case-insensitive.",
      },
    ],
    toolStubs: {
      start_developer_task: {
        taskId: "dt_eval_confirm",
        status: "needs_confirmation",
      },
    },
    expect: {
      tools: ["start_developer_task"],
      textExcludes: [
        "already started",
        "work has started",
        "i've started",
        "i have started",
        "started working",
      ],
    },
  },
  {
    id: "wake-failed",
    description: "Failing task wake digest — honest failure, no false done",
    bot: DELEGATE,
    messages: [{ role: "user", text: failedWake }],
    expect: {
      toolsForbidden: ["start_developer_task"],
      textExcludes: ["all done", "fixed it", "everything works", "successfully completed"],
    },
  },
  {
    id: "wake-completed",
    description: "Completed task wake digest — plain-words summary",
    bot: DELEGATE,
    messages: [{ role: "user", text: completedWake }],
    expect: {
      toolsForbidden: ["start_developer_task", "message_developer", "stop_developer_task"],
      textIncludes: ["sidebar"],
    },
  },
  {
    id: "es-fix-button",
    description: "Spanish change request — still start_developer_task",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        // Point at CookieBanner.tsx (present in the eval fixture). Asking for a
        // fictional "botón de registro" made the model ask clarifying questions.
        text: "Arregla CookieBanner.tsx: el banner de cookies tapa el contenido bajo 640px; baja el z-index.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  {
    id: "es-question",
    description: "Spanish question — no delegation",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "¿Qué hace useBots en este proyecto?",
      },
    ],
    expect: {
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "steer-add-test",
    description: "Mid-task steer — message_developer",
    bot: DELEGATE,
    messages: [
      {
        role: "assistant",
        text: "Having the sidebar search made case-insensitive now.",
      },
      {
        role: "user",
        text: `also add a test\n\n(active developer task id: dt_eval_running)`,
      },
    ],
    expect: {
      tools: ["message_developer"],
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "readonly-just-fix",
    description: "Read-only specialist asked to fix — must not start; handoff language",
    bot: READ_ONLY,
    messages: [
      {
        role: "user",
        text: "Just fix the flaky SidebarSearch test for me.",
      },
    ],
    expect: {
      toolsForbidden: [
        "start_developer_task",
        "message_developer",
        "check_developer_task",
        "answer_developer",
        "stop_developer_task",
      ],
      textIncludes: ["partner"],
    },
  },
  {
    id: "check-status",
    description: "User asks how the running task is going — check_developer_task",
    bot: DELEGATE,
    messages: [
      {
        role: "assistant",
        text: "Having the case-insensitive sidebar search change made.",
      },
      {
        role: "user",
        text: "How is that change going? (task id: dt_eval_running)",
      },
    ],
    toolStubs: {
      check_developer_task: {
        taskId: "dt_eval_running",
        goal: "Make sidebar search case-insensitive",
        state: "running",
        pendingRequest: null,
        result: null,
        failure: null,
        liveStatus: "Editing SidebarSearch.tsx",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      },
    },
    expect: {
      tools: ["check_developer_task"],
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "stop-task",
    description: "User cancels in-flight work — stop_developer_task",
    bot: DELEGATE,
    messages: [
      {
        role: "assistant",
        text: "Having the cookie banner z-index fix made.",
      },
      {
        role: "user",
        text: "Stop that. I changed my mind. (task id: dt_eval_running)",
      },
    ],
    toolStubs: {
      stop_developer_task: { status: "stopped" },
    },
    expect: {
      tools: ["stop_developer_task"],
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "answer-approval",
    description: "Developer waiting on approval — answer_developer",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: [
          "The developer task dt_eval_running is waiting on approval request req_42",
          "to run `pnpm test`. Please accept it.",
        ].join(" "),
      },
    ],
    toolStubs: {
      answer_developer: { status: "answered" },
    },
    expect: {
      tools: ["answer_developer"],
    },
  },
  {
    id: "change-typo-fix",
    description: "Tiny typo fix phrasing — still start",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "There's a typo in the empty-state copy in EmptyThread.tsx — please fix it.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
    },
  },
  // —— One case per Situation rule in partnerInstructions (PARTNER_PROMPT_VERSION) ——
  {
    id: "situation-bug-report",
    description: "Reports a problem: find the cause, name file and cause, start the fix",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "On my phone the cookie banner covers the page and I can't tap anything under it.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
      textIncludes: ["CookieBanner.tsx"],
      textExcludes: ["start_developer_task", "developer task"],
    },
  },
  {
    id: "situation-vague-request",
    description: "Vague request: one default plan through the plan card, not prose or questions",
    bot: DELEGATE,
    messages: [{ role: "user", text: "Make the sidebar search better." }],
    toolStubs: {
      start_developer_task: { status: "needs_confirmation", taskId: "dt_eval_plan" },
    },
    expect: {
      tools: ["start_developer_task"],
      textExcludes: ["go ahead?", "shall i", "should i proceed", "1.", "2.", "could you clarify"],
    },
  },
  {
    id: "situation-status-check",
    description: '"Is it done?": check the task, never guess',
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "<partner_context>\nbranch: main\nuncommitted files: 1\ndeveloper work:\n- running: Make sidebar search case-insensitive (dt_eval_running)\n</partner_context>\n\nIs it done yet?",
      },
    ],
    toolStubs: {
      check_developer_task: { task: sampleTask() },
    },
    expect: {
      tools: ["check_developer_task"],
      toolsForbidden: ["start_developer_task"],
      textExcludes: ["done.", "it's done", "finished"],
    },
  },
  {
    id: "situation-tests-failed",
    description: "Tests failed: say so in the first sentence",
    bot: DELEGATE,
    messages: [{ role: "user", text: failedWake }],
    expect: {
      textIncludes: ["fail", "SidebarSearch.test.tsx"],
      textExcludes: ["done", "fixed"],
      toolsForbidden: ["start_developer_task"],
    },
  },
  {
    id: "situation-frustrated",
    description: "Frustrated user: one short acknowledgement, then the fix",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "This is the THIRD time. Search still misses 'Foo' when I type 'foo'. Just fix it.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
      textIncludes: ["SidebarSearch.tsx"],
      textExcludes: ["I understand your frustration", "I apologize for the inconvenience"],
    },
  },
  {
    id: "situation-other-language",
    description: "Another language: reply in it, brief in English",
    bot: DELEGATE,
    messages: [
      {
        role: "user",
        text: "La recherche dans SidebarSearch.tsx est sensible à la casse. Corrige-la, s'il te plaît.",
      },
    ],
    expect: {
      tools: ["start_developer_task"],
      // The reply is French; the brief (checked by hand in the transcript) is English.
      textExcludes: ["I'm having", "I've started"],
    },
  },
  {
    id: "situation-review",
    description: "Review request: findings by severity with file paths, no task",
    bot: DELEGATE,
    messages: [
      { role: "user", text: "Review SidebarSearch.tsx and SidebarSearch.test.tsx for problems." },
    ],
    expect: {
      toolsForbidden: ["start_developer_task"],
      textIncludes: ["SidebarSearch.tsx"],
    },
  },
  {
    id: "situation-why-how",
    description: "Asks why/how: explain with file paths, offer to fix, don't start work",
    bot: DELEGATE,
    messages: [{ role: "user", text: "Why does the cookie banner cover the page on my phone?" }],
    expect: {
      toolsForbidden: ["start_developer_task", "message_developer"],
      textIncludes: ["CookieBanner.tsx"],
    },
  },
  {
    id: "situation-question",
    description: "Any other question: answer from the code, no task",
    bot: DELEGATE,
    messages: [{ role: "user", text: "Where is the cookie banner's breakpoint set?" }],
    expect: {
      toolsForbidden: ["start_developer_task", "message_developer"],
      textIncludes: ["CookieBanner.tsx"],
    },
  },
];
