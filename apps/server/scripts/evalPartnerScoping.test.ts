// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  EVAL_SCOPING_TOOL_NAMES,
  executeEvalScopingTool,
  resolveEvalRepoRoot,
} from "./evalPartnerScoping.ts";

describe("evalPartnerScoping", () => {
  const root = resolveEvalRepoRoot();

  it("resolves the eval fixture root that contains SidebarSearch.tsx", () => {
    expect(NodeFs.existsSync(NodePath.join(root, "apps", "web", "src", "SidebarSearch.tsx"))).toBe(
      true,
    );
  });

  it("lists Read/Grep/Glob as scoping tools", () => {
    expect([...EVAL_SCOPING_TOOL_NAMES].sort()).toEqual(["Glob", "Grep", "Read"]);
  });

  it("reads a known fixture file", () => {
    const raw = executeEvalScopingTool(
      "Read",
      { path: "apps/web/src/SidebarSearch.tsx", limit: 10 },
      root,
    );
    const parsed = JSON.parse(raw) as { content?: string; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.content).toContain("SidebarSearch");
  });

  it("greps for a known fixture symbol", () => {
    const raw = executeEvalScopingTool("Grep", { pattern: "useBots", path: "apps/web/src" }, root);
    const parsed = JSON.parse(raw) as { matches?: string; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.matches).toContain("useBots");
  });

  it("refuses paths that escape the repo root", () => {
    const raw = executeEvalScopingTool("Read", { path: "../../etc/passwd" }, root);
    expect(JSON.parse(raw)).toMatchObject({ error: expect.stringContaining("escapes") });
  });
});
