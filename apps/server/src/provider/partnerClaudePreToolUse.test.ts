import { describe, expect, it } from "vite-plus/test";

import {
  partnerClaudePreToolUseDecision,
  partnerClaudePreToolUseHooks,
} from "./partnerClaudePreToolUse.ts";

describe("partnerClaudePreToolUseDecision", () => {
  it("denies Bash(touch) even when settings would allow Bash(touch:*)", () => {
    // Ordering note: PreToolUse runs before permissions.allow rules, so a
    // partner settings allow like "Bash(touch:*)" cannot bypass this deny.
    const decision = partnerClaudePreToolUseDecision("Bash", { command: "touch x" });
    expect(decision.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("read-only"),
    });
  });

  it("denies AskUserQuestion and ExitPlanMode so partner threads do not hang on an empty ask", () => {
    for (const toolName of ["AskUserQuestion", "ExitPlanMode"] as const) {
      expect(partnerClaudePreToolUseDecision(toolName, {}).hookSpecificOutput).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/AskUserQuestion|ExitPlanMode|reply/),
      });
    }
  });

  it("denies Write / Edit and mutating Bash; allows read-only Bash and Read", () => {
    expect(
      partnerClaudePreToolUseDecision("Write", { file_path: "/x" }).hookSpecificOutput,
    ).toMatchObject({ permissionDecision: "deny" });
    expect(
      partnerClaudePreToolUseDecision("Bash", { command: "sed -i s/a/b/ f" }).hookSpecificOutput,
    ).toMatchObject({ permissionDecision: "deny" });
    expect(partnerClaudePreToolUseDecision("Bash", { command: "git status" })).toEqual({
      continue: true,
    });
    expect(partnerClaudePreToolUseDecision("Bash", { command: "rg foo src" })).toEqual({
      continue: true,
    });
    expect(partnerClaudePreToolUseDecision("Read", { file_path: "/x" })).toEqual({
      continue: true,
    });
  });

  it("registers a PreToolUse matcher for query options", () => {
    const hooks = partnerClaudePreToolUseHooks();
    expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });
});
