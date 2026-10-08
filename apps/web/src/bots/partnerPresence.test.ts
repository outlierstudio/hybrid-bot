import { describe, expect, it } from "vite-plus/test";

import {
  composerEngineControlMode,
  derivePartnerPresence,
  needsYouFirst,
  resolveThreadRowState,
  type ThreadRowState,
} from "./partnerPresence";

describe("derivePartnerPresence", () => {
  it("is Ready with no live work and no open cards", () => {
    expect(derivePartnerPresence({ work: [], openDecisionCards: 0, openPlanCards: 0 })).toEqual({
      kind: "ready",
      text: "Ready",
    });
    expect(
      derivePartnerPresence({
        work: [{ state: "completed", liveStatus: null }],
        openDecisionCards: 0,
        openPlanCards: 0,
      }).kind,
    ).toBe("ready");
  });

  it("uses the newest live task's beat", () => {
    expect(
      derivePartnerPresence({
        work: [
          { state: "completed", liveStatus: null },
          { state: "running", liveStatus: "Running `pnpm test`…" },
        ],
        openDecisionCards: 0,
        openPlanCards: 0,
      }),
    ).toEqual({ kind: "working", text: "Running `pnpm test`…" });
    expect(
      derivePartnerPresence({
        work: [{ state: "queued", liveStatus: "  " }],
        openDecisionCards: 0,
        openPlanCards: 0,
      }).text,
    ).toBe("Working");
  });

  it("is Waiting for you when a card is open or a task waits on the user", () => {
    const working = [{ state: "running" as const, liveStatus: "Editing" }];
    for (const input of [
      { work: working, openDecisionCards: 1, openPlanCards: 0 },
      { work: working, openDecisionCards: 0, openPlanCards: 1 },
      {
        work: [{ state: "waiting-on-user" as const, liveStatus: null }],
        openDecisionCards: 0,
        openPlanCards: 0,
      },
    ]) {
      expect(derivePartnerPresence(input)).toEqual({ kind: "waiting", text: "Waiting for you" });
    }
  });
});

describe("resolveThreadRowState", () => {
  const base = {
    partnerState: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
  } as const;

  it("needs you beats working beats done-unread", () => {
    expect(resolveThreadRowState({ ...base, partnerState: "needs-user" }, true)).toBe("needs-you");
    expect(resolveThreadRowState({ ...base, hasPendingApprovals: true }, false)).toBe("needs-you");
    expect(resolveThreadRowState({ ...base, partnerState: "working" }, true)).toBe("working");
    expect(resolveThreadRowState(base, true)).toBe("done-unread");
    expect(resolveThreadRowState(base, false)).toBeNull();
  });
});

describe("needsYouFirst", () => {
  it("moves needs-you threads to the top and keeps the rest in order", () => {
    const states: Record<string, ThreadRowState | null> = {
      a: null,
      b: "needs-you",
      c: "working",
      d: "needs-you",
      e: "done-unread",
    };
    expect(needsYouFirst(["a", "b", "c", "d", "e"], (id) => states[id] ?? null)).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
  });

  it("returns the same array when nothing needs the user", () => {
    const threads = ["a", "b"];
    expect(needsYouFirst(threads, () => null)).toBe(threads);
  });
});

describe("composerEngineControlMode", () => {
  it("is always the folded control with Developer directly off", () => {
    expect(composerEngineControlMode("builtin-engineer")).toBe("compact");
    expect(composerEngineControlMode(null)).toBe("compact");
    expect(composerEngineControlMode(undefined, false)).toBe("compact");
  });

  it("flag on: compact on partner threads, full for Developer directly", () => {
    expect(composerEngineControlMode("builtin-engineer", true)).toBe("compact");
    expect(composerEngineControlMode(null, true)).toBe("full");
  });
});
