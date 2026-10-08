import { describe, expect, it } from "vite-plus/test";

import {
  PARTNER_CLAUDE_DEVELOPER_TOOLS,
  PARTNER_CLAUDE_DISALLOWED_TOOLS,
  PARTNER_CLAUDE_SCOPING_TOOLS,
  partnerClaudeMcpQueryOptions,
} from "./partnerClaudeMcp.ts";
import { partnerReadOnlyDenial } from "./partnerReadOnly.ts";

describe("partnerClaudeMcpQueryOptions", () => {
  it("isolates t3-code and lists the developer tools Claude Code exposes", () => {
    const options = partnerClaudeMcpQueryOptions({
      endpoint: "http://127.0.0.1:13773/mcp",
      authorizationHeader: "Bearer test",
    });

    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers["t3-code"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:13773/mcp",
      headers: { Authorization: "Bearer test" },
    });
    expect(options.allowedTools).toEqual([
      ...PARTNER_CLAUDE_SCOPING_TOOLS,
      ...PARTNER_CLAUDE_DEVELOPER_TOOLS,
    ]);
    expect(options.disallowedTools).toEqual([...PARTNER_CLAUDE_DISALLOWED_TOOLS]);
    expect(options.allowedTools).toContain("mcp__t3-code__start_developer_task");
  });

  it("keeps Bash out of allowedTools so canUseTool / partnerReadOnlyDenial can gate it", () => {
    const options = partnerClaudeMcpQueryOptions({
      endpoint: "http://127.0.0.1:13773/mcp",
      authorizationHeader: "Bearer test",
    });

    expect(PARTNER_CLAUDE_SCOPING_TOOLS).not.toContain("Bash");
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob", "mcp__t3-code__start_developer_task"]),
    );
  });

  it("disallows AskUserQuestion and ExitPlanMode for partner sessions", () => {
    const options = partnerClaudeMcpQueryOptions({
      endpoint: "http://127.0.0.1:13773/mcp",
      authorizationHeader: "Bearer test",
    });
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["AskUserQuestion", "ExitPlanMode"]),
    );
    expect(partnerReadOnlyDenial("AskUserQuestion", {})).toEqual(
      expect.stringMatching(/AskUserQuestion|ExitPlanMode|reply/),
    );
    expect(partnerReadOnlyDenial("ExitPlanMode", {})).toEqual(
      expect.stringMatching(/AskUserQuestion|ExitPlanMode|reply/),
    );
  });
});

describe("partner Bash gating via canUseTool path", () => {
  it("denies mutating Bash and allows read-only Bash", () => {
    expect(partnerReadOnlyDenial("Bash", { command: "touch x" })).toEqual(
      expect.stringContaining("read-only"),
    );
    expect(partnerReadOnlyDenial("Bash", { command: "sed -i s/a/b/ file.txt" })).toEqual(
      expect.stringContaining("read-only"),
    );
    expect(partnerReadOnlyDenial("Bash", { command: "git status" })).toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "rg foo src" })).toBeNull();
  });
});
