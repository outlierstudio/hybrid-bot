/**
 * HYBRID: Claude partner sessions must isolate the t3-code MCP map and name the
 * partner tools explicitly. Without this, user/project MCP config crowds out
 * `start_developer_task`, and Claude Code exposes tools as `mcp__t3-code__*`.
 */

export const PARTNER_CLAUDE_MCP_SERVER_NAME = "t3-code";

/**
 * Scoping tools auto-approved by Claude Code when listed in allowedTools.
 * Bash is intentionally omitted: the SDK skips canUseTool for bare allowedTools
 * entries, which would bypass partnerReadOnlyDenial (B1 / S0).
 */
export const PARTNER_CLAUDE_SCOPING_TOOLS = ["Read", "Grep", "Glob"] as const;

export const PARTNER_CLAUDE_DEVELOPER_TOOLS = [
  "mcp__t3-code__start_developer_task",
  "mcp__t3-code__check_developer_task",
  "mcp__t3-code__message_developer",
  "mcp__t3-code__answer_developer",
  "mcp__t3-code__stop_developer_task",
] as const;

/**
 * Built-in Claude tools partners must not use. AskUserQuestion / ExitPlanMode
 * would otherwise surface through canUseTool before the partner check; partner
 * threads hide those asks, leaving an empty stuck box. Partners ask in prose
 * until ask_user exists (Phase 5).
 */
export const PARTNER_CLAUDE_DISALLOWED_TOOLS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "AskUserQuestion",
  "ExitPlanMode",
] as const;

export type PartnerClaudeMcpSession = {
  readonly endpoint: string;
  readonly authorizationHeader: string;
};

/** Query options that make the partner toolkit first-class for Claude Code. */
export function partnerClaudeMcpQueryOptions(mcpSession: PartnerClaudeMcpSession): {
  strictMcpConfig: true;
  mcpServers: {
    "t3-code": {
      type: "http";
      url: string;
      headers: { Authorization: string };
    };
  };
  allowedTools: string[];
  disallowedTools: string[];
} {
  return {
    strictMcpConfig: true,
    mcpServers: {
      [PARTNER_CLAUDE_MCP_SERVER_NAME]: {
        type: "http",
        url: mcpSession.endpoint,
        headers: {
          Authorization: mcpSession.authorizationHeader,
        },
      },
    },
    allowedTools: [...PARTNER_CLAUDE_SCOPING_TOOLS, ...PARTNER_CLAUDE_DEVELOPER_TOOLS],
    disallowedTools: [...PARTNER_CLAUDE_DISALLOWED_TOOLS],
  };
}
