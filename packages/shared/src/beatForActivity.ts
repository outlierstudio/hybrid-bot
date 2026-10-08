/**
 * HYBRID: present-tense status beats for developer-task activity (AUDIT §5.5).
 *
 * Pure and shared so the server can publish `liveStatus` and web/mobile can render
 * the same strings. Clients import via `@t3tools/client-runtime/developer-task/beat-for-activity`.
 */
import type { ToolLifecycleItemType } from "@t3tools/contracts";

export type BeatPendingKind = "approval" | "question";

/** Normalized activity — not raw OrchestrationThreadActivity. */
export type BeatActivity =
  | {
      readonly kind: "tool";
      readonly itemType?: ToolLifecycleItemType | null | undefined;
      readonly title?: string | null | undefined;
      readonly command?: string | null | undefined;
      readonly paths?: ReadonlyArray<string> | undefined;
      readonly status?: "inProgress" | "completed" | "failed" | "declined" | "stopped" | null;
    }
  | {
      readonly kind: "pending";
      readonly pending: BeatPendingKind;
    }
  | {
      readonly kind: "idle";
      /** Milliseconds since the last meaningful tool/pending update while the task is running. */
      readonly idleMs: number;
    };

const basename = (path: string): string => {
  const normalized = path.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
};

const relativize = (path: string, workspaceRoot: string | undefined): string => {
  if (!workspaceRoot) return path;
  const root = workspaceRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalized = path.replace(/\\/gu, "/");
  if (normalized === root) return ".";
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return path;
};

const displayPath = (path: string, workspaceRoot: string | undefined): string => {
  const relative = relativize(path, workspaceRoot);
  // Prefer a short leaf when the relative path is deep.
  const parts = relative.replace(/\\/gu, "/").split("/");
  return parts.length > 3 ? basename(relative) : relative;
};

const firstProgram = (command: string): string => {
  const trimmed = command.trim();
  if (!trimmed) return "";
  // Strip common wrappers: env FOO=bar, npx/pnpm/yarn/bun/npm run …
  const tokens = trimmed.split(/\s+/u);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "env" || token.includes("=")) {
      i += 1;
      continue;
    }
    if (
      token === "npx" ||
      token === "pnpm" ||
      token === "yarn" ||
      token === "bun" ||
      token === "npm" ||
      token === "bunx"
    ) {
      i += 1;
      if (tokens[i] === "run" || tokens[i] === "exec" || tokens[i] === "dlx") i += 1;
      continue;
    }
    if (token === "command" || token === "time" || token === "nice") {
      i += 1;
      continue;
    }
    return token.replace(/^.*\//u, "").toLowerCase();
  }
  return "";
};

const isTestCommand = (command: string): boolean => {
  const program = firstProgram(command);
  if (
    program === "vitest" ||
    program === "jest" ||
    program === "pytest" ||
    program === "cargo" ||
    program === "go" ||
    program === "mocha" ||
    program === "ava" ||
    program === "tap"
  ) {
    if (program === "cargo" || program === "go") {
      return /\btest\b/iu.test(command);
    }
    return true;
  }
  if (/\b(vitest|jest|pytest|mocha)\b/iu.test(command)) return true;
  if (/\b(pnpm|npm|yarn|bun)\s+(test|run\s+test)\b/iu.test(command)) return true;
  if (/\bcargo\s+test\b/iu.test(command) || /\bgo\s+test\b/iu.test(command)) return true;
  return false;
};

const isTypecheckCommand = (command: string): boolean => {
  if (/\btsc\b/iu.test(command) && !/\b(watch)\b/iu.test(command)) return true;
  if (/\b(typecheck|type-check|typo?check)\b/iu.test(command)) return true;
  if (/\b(pnpm|npm|yarn|bun)\s+run\s+typecheck\b/iu.test(command)) return true;
  return false;
};

const isLintCommand = (command: string): boolean => {
  if (/\b(eslint|oxlint|biome\s+check|ruff\s+check)\b/iu.test(command)) return true;
  if (/\b(pnpm|npm|yarn|bun)\s+(lint|run\s+lint)\b/iu.test(command)) return true;
  return false;
};

const isBuildCommand = (command: string): boolean => {
  if (/\b(vite\s+build|next\s+build|webpack|turbo\s+build|tsup|esbuild)\b/iu.test(command)) {
    return true;
  }
  if (/\b(pnpm|npm|yarn|bun)\s+(build|run\s+build)\b/iu.test(command)) return true;
  if (/\bcargo\s+build\b/iu.test(command)) return true;
  return false;
};

const isInstallCommand = (command: string): boolean => {
  if (/\b(pnpm|npm|yarn|bun)\s+(i|install|add)\b/iu.test(command)) return true;
  if (/\bpip(3)?\s+install\b/iu.test(command)) return true;
  if (/\bcargo\s+add\b/iu.test(command)) return true;
  if (/\bbrew\s+install\b/iu.test(command)) return true;
  return false;
};

const titleLooksLike = (title: string | null | undefined, ...needles: string[]): boolean => {
  if (!title) return false;
  const lower = title.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
};

const isReadTool = (activity: Extract<BeatActivity, { kind: "tool" }>): boolean => {
  const itemType = activity.itemType ?? undefined;
  if (itemType === "image_view") return true;
  if (itemType === "web_search") return false;
  if (itemType === "file_change" || itemType === "command_execution") return false;
  if (titleLooksLike(activity.title, "read", "grep", "glob", "search files", "find files")) {
    return true;
  }
  // dynamic_tool_call / mcp with read-ish titles already caught above; itemType alone is weak.
  if (itemType === undefined && titleLooksLike(activity.title, "looking", "inspect", "open file")) {
    return true;
  }
  // Explicit read-ish item types from adapters often arrive as dynamic tools with a title.
  return titleLooksLike(activity.title, "read file", "read `");
};

const isEditTool = (activity: Extract<BeatActivity, { kind: "tool" }>): boolean => {
  if (activity.itemType === "file_change") return true;
  return titleLooksLike(
    activity.title,
    "edit",
    "write",
    "apply_patch",
    "apply patch",
    "strreplace",
    "str_replace",
    "create file",
  );
};

const formatIdle = (idleMs: number): string => {
  const totalSeconds = Math.floor(idleMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 1) return "Still working";
  if (minutes < 60) return `Still working (${minutes}m)`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `Still working (${hours}h)` : `Still working (${hours}h${rem}m)`;
};

/**
 * Map one normalized activity to a present-tense beat, or `null` when there is nothing to show
 * (for example a completed tool with no pending work, or idle under 60s).
 */
export function beatForActivity(
  activity: BeatActivity,
  workspaceRoot: string | undefined,
): string | null {
  switch (activity.kind) {
    case "pending":
      return activity.pending === "approval" ? "Waiting on your OK" : "Waiting on your answer";
    case "idle":
      return activity.idleMs > 60_000 ? formatIdle(activity.idleMs) : null;
    case "tool": {
      if (activity.status === "completed" || activity.status === "failed") {
        // Completed tools do not keep a beat by themselves; idle/pending take over.
        return null;
      }
      const paths = activity.paths?.filter((p) => p.trim().length > 0) ?? [];
      if (isEditTool(activity)) {
        if (paths.length === 0) return "Editing files";
        if (paths.length === 1) {
          return `Editing \`${displayPath(paths[0]!, workspaceRoot)}\``;
        }
        return `Editing ${paths.length} files`;
      }
      if (isReadTool(activity) || activity.itemType === "web_search") {
        // grep/glob across many hits → looking through N; single path → Reading.
        if (titleLooksLike(activity.title, "grep", "glob", "search") && paths.length !== 1) {
          const n = paths.length > 0 ? paths.length : undefined;
          return n !== undefined ? `Looking through ${n} files` : "Looking through files";
        }
        if (paths.length === 1) {
          return `Reading \`${displayPath(paths[0]!, workspaceRoot)}\``;
        }
        if (paths.length > 1) return `Looking through ${paths.length} files`;
        return "Reading files";
      }
      const command = activity.command?.trim() ?? "";
      if (command.length > 0 || activity.itemType === "command_execution") {
        if (command.length > 0) {
          if (isTestCommand(command)) return "Running tests";
          if (isTypecheckCommand(command)) return "Checking types";
          if (isLintCommand(command)) return "Checking types";
          if (isBuildCommand(command)) return "Building";
          if (isInstallCommand(command)) return "Installing a dependency";
        }
        return "Running a command";
      }
      return null;
    }
  }
}

/** Idle threshold used by the server's liveStatus ticker (AUDIT §5.5). */
export const BEAT_IDLE_THRESHOLD_MS = 60_000;

/** Max publish rate for developer-task liveStatus (AUDIT §5.5). */
export const LIVE_STATUS_COALESCE_MS = 750;
