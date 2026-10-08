import { describe, expect, it } from "vite-plus/test";

import {
  buildPartnerContext,
  PARTNER_CONTEXT_MAX_CHARS,
  type PartnerContextInput,
} from "./partnerContext.ts";

const base: PartnerContextInput = {
  branch: "hybrid/v0.2.0",
  uncommittedFiles: 3,
  tasks: [],
};

describe("buildPartnerContext", () => {
  it("lists branch, uncommitted count, and developer work", () => {
    const text = buildPartnerContext({
      ...base,
      tasks: [
        { taskId: "dt_1", goal: "Fix the cookie banner", state: "completed" },
        { taskId: "dt_2", goal: "Make search case-insensitive", state: "running" },
      ],
    });
    expect(text).toBe(
      [
        "<partner_context>",
        "branch: hybrid/v0.2.0",
        "uncommitted files: 3",
        "developer work:",
        "- running: Make search case-insensitive (dt_2)",
        "- completed: Fix the cookie banner (dt_1)",
        "</partner_context>",
      ].join("\n"),
    );
  });

  it("is null when there is nothing to say", () => {
    expect(buildPartnerContext({ branch: null, uncommittedFiles: null, tasks: [] })).toBeNull();
  });

  it("keeps open work and the three latest finished tasks, five at most", () => {
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      taskId: `dt_${index}`,
      goal: `Task ${index}`,
      state: index === 1 ? ("waiting-on-user" as const) : ("completed" as const),
    }));
    const text = buildPartnerContext({ ...base, tasks })!;
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      "- waiting-on-user: Task 1 (dt_1)",
      "- completed: Task 5 (dt_5)",
      "- completed: Task 6 (dt_6)",
      "- completed: Task 7 (dt_7)",
    ]);
  });

  it("never exceeds the length cap, however long the inputs", () => {
    const text = buildPartnerContext({
      branch: "b".repeat(5000),
      uncommittedFiles: 12_000,
      tasks: Array.from({ length: 50 }, (_, index) => ({
        taskId: `dt_${index}`,
        goal: "a very long goal ".repeat(100),
        state: "running" as const,
      })),
    })!;
    expect(text.length).toBeLessThanOrEqual(PARTNER_CONTEXT_MAX_CHARS);
    expect(text.startsWith("<partner_context>")).toBe(true);
    expect(text.endsWith("</partner_context>")).toBe(true);
  });

  it("has no field for file contents or env values", () => {
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
    process.env.HYBRID_TEST_SECRET = secret;
    try {
      const text = buildPartnerContext({ ...base, uncommittedFiles: 2 })!;
      expect(text).not.toContain(secret);
      expect(text).toContain("uncommitted files: 2");
    } finally {
      delete process.env.HYBRID_TEST_SECRET;
    }
  });
});
