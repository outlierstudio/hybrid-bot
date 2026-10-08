import type { DeveloperTask } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DeveloperWorkCard } from "./DeveloperWorkCard";
import { deriveDeveloperWorkCards, type DeveloperWorkCardModel } from "./developerWork";

const card = (
  overrides: Partial<DeveloperTask>,
  liveStatuses: Record<string, string | null> = {},
): DeveloperWorkCardModel => {
  const [model] = deriveDeveloperWorkCards(
    [
      {
        taskId: "t1",
        parentThreadId: "thread-parent",
        parentTurnId: "turn-1",
        workThreadId: "thread-work",
        workTurnIds: [],
        botId: "builtin-engineer",
        brief: {
          goal: "Fix the cookie banner",
          context: "",
          constraints: "",
          acceptance: "",
          scope: "small",
        },
        runtimeMode: "full-access",
        modelSelection: { instanceId: "inst-1", model: "gpt-5" },
        state: "running",
        pendingRequest: null,
        result: null,
        failure: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        startedAt: "2026-08-01T00:00:01.000Z",
        completedAt: null,
        ...overrides,
      } as unknown as DeveloperTask,
    ],
    liveStatuses,
  );
  if (!model) throw new Error("expected a card");
  return model;
};

const render = (work: DeveloperWorkCardModel, withActions = true) =>
  renderToStaticMarkup(
    <DeveloperWorkCard
      work={work}
      onStop={withActions ? () => Promise.resolve() : null}
      onShowDiff={withActions ? () => {} : null}
      renderWorkThread={withActions ? () => <div>work thread</div> : null}
    />,
  );

describe("DeveloperWorkCard", () => {
  it("shows goal, state pill, live beat, and all three actions while running", () => {
    const html = render(card({}, { t1: "Running tests" }));
    expect(html).toContain("Fix the cookie banner");
    expect(html).toContain("Working");
    expect(html).toContain("Running tests");
    expect(html).toContain("Show work");
    expect(html).toContain("Show diff");
    expect(html).toContain("Stop");
    // The work thread stays closed until the user asks.
    expect(html).not.toContain("work thread");
  });

  it("shows files, line counts, checks, and elapsed time once completed, with no Stop", () => {
    const html = render(
      card({
        state: "completed",
        completedAt: "2026-08-01T00:03:13.000Z",
        result: {
          summary: "Moved the banner.",
          filesChanged: [{ path: "src/CookieBanner.tsx", additions: 6, deletions: 2 }],
          checks: [{ command: "pnpm test", outcome: "passed" }],
          checkpointTurnCount: 1,
        },
      }),
    );
    expect(html).toContain("Done");
    expect(html).toContain("3m 12s");
    expect(html).toContain("1 file changed");
    expect(html).toContain("src/CookieBanner.tsx");
    expect(html).toContain("+6");
    expect(html).toContain("-2");
    expect(html).toContain("pnpm test");
    expect(html).toContain("Moved the banner.");
    expect(html).not.toContain(">Stop<");
  });

  it("offers neither Show work nor Show diff before a work thread exists", () => {
    const html = render(card({ state: "queued", workThreadId: null, startedAt: null }));
    expect(html).toContain("Queued");
    expect(html).not.toContain("Show work");
    expect(html).not.toContain("Show diff");
    expect(html).toContain("Stop");
  });

  it("explains a failure", () => {
    const html = render(
      card({ state: "failed", failure: { code: "timeout", message: "It ran out of time." } }),
    );
    expect(html).toContain("Failed");
    expect(html).toContain("It ran out of time.");
  });

  it("disables Stop when this client cannot stop tasks", () => {
    const html = render(card({}), false);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Stop<\/button>/);
  });
});
