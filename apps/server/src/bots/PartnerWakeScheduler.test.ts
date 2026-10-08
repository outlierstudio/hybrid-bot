import {
  BotId,
  DeveloperTaskId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DeveloperTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatWakeDigest, type PartnerWakeMilestone } from "./PartnerWakeScheduler.ts";

const task = (overrides: Partial<DeveloperTask> = {}): DeveloperTask => ({
  taskId: DeveloperTaskId.make("dt_9f2"),
  parentThreadId: ThreadId.make("parent-1"),
  parentTurnId: TurnId.make("turn-1"),
  workThreadId: ThreadId.make("work-1"),
  workTurnIds: [],
  botId: BotId.make("bot-1"),
  brief: {
    goal: "Fix signup button hidden behind cookie banner on small screens",
    context: "CookieBanner z-index",
    constraints: "",
    acceptance: "pnpm test",
    scope: "small",
  },
  runtimeMode: "approval-required",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  state: "completed",
  pendingRequest: null,
  result: {
    summary:
      "Lowered banner z-index, moved it below the form under 640px, added CookieBanner.test.tsx case for 375px. `pnpm test` passed (214).",
    filesChanged: [
      { path: "src/components/CookieBanner.tsx", additions: 6, deletions: 2 },
      { path: "src/components/CookieBanner.test.tsx", additions: 28, deletions: 0 },
    ],
    checks: [],
    checkpointTurnCount: 1,
  },
  failure: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:03:12.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:03:12.000Z",
  ...overrides,
});

describe("formatWakeDigest", () => {
  it("matches the AUDIT §5.5 completed template shape", () => {
    const milestone: PartnerWakeMilestone = { kind: "task.completed", task: task() };
    const text = formatWakeDigest([milestone]);
    expect(text).toContain('<hybrid_event kind="task.completed" task="dt_9f2" elapsed="3m12s">');
    expect(text).toContain("goal: Fix signup button");
    expect(text).toContain("developer said: Lowered banner z-index");
    expect(text).toContain("files: src/components/CookieBanner.tsx (+6 -2)");
    expect(text).toContain("Tell the user what changed in plain words");
    expect(text).not.toContain("ask_user");
  });

  it("coalesces multiple milestones into sequential event blocks", () => {
    const text = formatWakeDigest([
      {
        kind: "approval.declined",
        task: task({ state: "running", result: null, completedAt: null }),
        bodyLines: ["request: git push", "reason: outside the worktree"],
      },
      {
        kind: "task.failed",
        task: task({
          state: "failed",
          result: null,
          failure: { code: "interrupted", message: "The developer was interrupted." },
        }),
      },
    ]);
    expect(text).toContain('kind="approval.declined"');
    expect(text).toContain('kind="task.failed"');
    expect(text).toContain("failure: The developer was interrupted.");
  });

  it("lists filesChanged on failed tasks so the partner cannot claim nothing changed", () => {
    const text = formatWakeDigest([
      {
        kind: "task.failed",
        task: task({
          state: "failed",
          failure: { code: "developer-failed", message: "Bash could not reach apps/web." },
          result: {
            summary: "Bash could not reach apps/web.",
            filesChanged: [{ path: "apps/web/src/bots/hatchBot.ts", additions: 2, deletions: 3 }],
            checks: [],
            checkpointTurnCount: 1,
          },
        }),
      },
    ]);
    expect(text).toContain('kind="task.failed"');
    expect(text).toContain("failure: Bash could not reach apps/web.");
    expect(text).toContain("files: apps/web/src/bots/hatchBot.ts (+2 -3)");
  });
});
