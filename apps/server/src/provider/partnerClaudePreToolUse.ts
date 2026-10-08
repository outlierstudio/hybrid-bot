/**
 * HYBRID: PreToolUse hook for Claude partner sessions.
 *
 * Claude Code permission order (partner-relevant):
 * 1. PreToolUse hooks (this module) — run first
 * 2. settings `permissions.allow` / `deny` rules from user/project/local
 * 3. `canUseTool` — skipped for bare `allowedTools` entries
 *
 * A settings rule like `Bash(touch:*)` would otherwise auto-approve before
 * `partnerReadOnlyDenial` in canUseTool ever runs. Denying here closes that gap.
 * Keep the canUseTool check as a second line of defense.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { partnerReadOnlyDenial } from "./partnerReadOnly.ts";

/** Pure decision for tests and for the SDK hook callback. */
export function partnerClaudePreToolUseDecision(
  toolName: string,
  toolInput: unknown,
): SyncHookJSONOutput {
  const denial = partnerReadOnlyDenial(toolName, toolInput);
  if (denial === null) {
    return { continue: true };
  }
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denial,
    },
  };
}

export const partnerClaudePreToolUseHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") {
    return { continue: true };
  }
  return partnerClaudePreToolUseDecision(input.tool_name, input.tool_input);
};

/** Query `hooks` fragment for partner-only Claude sessions. */
export function partnerClaudePreToolUseHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [partnerClaudePreToolUseHook] }],
  };
}
