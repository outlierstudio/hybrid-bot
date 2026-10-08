// @effect-diagnostics nodeBuiltinImport:off
/**
 * Eval-only Read/Grep/Glob so question scenarios can answer without
 * start_developer_task. The real partner session has these tools; the
 * structured-output eval previously listed only developer MCP tools and
 * pointed the model at an empty temp cwd, which forced over-delegation.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

export const EVAL_SCOPING_TOOL_DOCS: ReadonlyArray<{
  readonly name: string;
  readonly doc: string;
}> = [
  {
    name: "Read",
    doc: JSON.stringify({
      description: "Read a file from the project. Path is relative to the project root.",
      parameters: {
        path: "string (required)",
        offset: "number (optional)",
        limit: "number (optional)",
      },
    }),
  },
  {
    name: "Grep",
    doc: JSON.stringify({
      description: "Search file contents with ripgrep. Returns matching lines.",
      parameters: {
        pattern: "string (required)",
        path: "string (optional, defaults to .)",
        glob: "string (optional)",
      },
    }),
  },
  {
    name: "Glob",
    doc: JSON.stringify({
      description: "List files matching a glob under the project root.",
      parameters: { pattern: "string (required)" },
    }),
  },
];

export const EVAL_SCOPING_TOOL_NAMES: ReadonlySet<string> = new Set(
  EVAL_SCOPING_TOOL_DOCS.map((tool) => tool.name),
);

/**
 * Project root for Read/Grep/Glob. Prefer the scripted fixture tree (fictional
 * paths from evalPartnerCases), then EVAL_PARTNER_ROOT, then walk up for a
 * real monorepo.
 */
export function resolveEvalRepoRoot(start: string = process.cwd()): string {
  const fixture = NodePath.resolve(
    NodePath.dirname(new URL(import.meta.url).pathname),
    "eval-fixtures",
    "hybrid",
  );
  if (NodeFs.existsSync(NodePath.join(fixture, "apps", "web", "src", "SidebarSearch.tsx"))) {
    return fixture;
  }
  const fromEnv = process.env.EVAL_PARTNER_ROOT?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return NodePath.resolve(fromEnv);
  }
  let dir = NodePath.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (
      NodeFs.existsSync(NodePath.join(dir, "apps", "server")) &&
      NodeFs.existsSync(NodePath.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return NodePath.resolve(start);
}

const MAX_BYTES = 24_000;

function clip(text: string): string {
  if (text.length <= MAX_BYTES) return text;
  return `${text.slice(0, MAX_BYTES)}\n…(truncated)`;
}

function resolveUnderRoot(root: string, relativePath: string): string | null {
  const resolved = NodePath.resolve(root, relativePath);
  const rootWithSep = root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

/** Execute a scoping tool against the real repo; returns a JSON string for the transcript. */
export function executeEvalScopingTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
): string {
  try {
    if (name === "Read") {
      const pathArg =
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
            ? args.file_path
            : "";
      if (!pathArg) return JSON.stringify({ error: "Read requires path" });
      const absolute = resolveUnderRoot(root, pathArg);
      if (absolute === null) return JSON.stringify({ error: "path escapes project root" });
      if (!NodeFs.existsSync(absolute) || !NodeFs.statSync(absolute).isFile()) {
        return JSON.stringify({ error: `file not found: ${pathArg}` });
      }
      const raw = NodeFs.readFileSync(absolute, "utf8");
      const lines = raw.split(/\r?\n/);
      const offset =
        typeof args.offset === "number" && Number.isFinite(args.offset)
          ? Math.max(0, Math.floor(args.offset))
          : 0;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.floor(args.limit))
          : lines.length;
      const slice = lines.slice(offset, offset + limit).join("\n");
      return JSON.stringify({ path: pathArg, content: clip(slice) });
    }

    if (name === "Grep") {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) return JSON.stringify({ error: "Grep requires pattern" });
      const searchPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
      const absolute = resolveUnderRoot(root, searchPath);
      if (absolute === null) return JSON.stringify({ error: "path escapes project root" });
      const rgArgs = ["-n", "--no-heading", "-m", "40", pattern, absolute];
      if (typeof args.glob === "string" && args.glob.length > 0) {
        rgArgs.splice(0, 0, "--glob", args.glob);
      }
      const result = NodeChildProcess.spawnSync("rg", rgArgs, {
        encoding: "utf8",
        cwd: root,
        maxBuffer: MAX_BYTES * 2,
      });
      if (result.status === 1) return JSON.stringify({ matches: [], note: "no matches" });
      if (result.status !== 0 && result.status !== 1) {
        return JSON.stringify({
          error: result.stderr?.trim() || `rg exited ${result.status}`,
        });
      }
      return JSON.stringify({ matches: clip(result.stdout ?? "") });
    }

    if (name === "Glob") {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) return JSON.stringify({ error: "Glob requires pattern" });
      const result = NodeChildProcess.spawnSync("rg", ["--files", "-g", pattern, root], {
        encoding: "utf8",
        cwd: root,
        maxBuffer: MAX_BYTES * 2,
      });
      if (result.error) {
        return JSON.stringify({ error: result.error.message });
      }
      const files = (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 80)
        .map((line) => NodePath.relative(root, line));
      return JSON.stringify({ files });
    }

    return JSON.stringify({ error: `unknown scoping tool: ${name}` });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
