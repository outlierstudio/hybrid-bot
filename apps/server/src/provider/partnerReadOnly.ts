/**
 * HYBRID: read-only partner profile for providers that gate tools themselves
 * (Claude `canUseTool`). Internal; not a user-selectable RuntimeMode.
 */

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

/** Claude built-ins that leave partner threads with an empty, stuck ask UI. */
const PARTNER_DISALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
]);

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "pwd",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "fd",
  "tree",
  "stat",
  "file",
  "which",
  "echo",
  "printf",
  "diff",
  "sort",
  "uniq",
  "cut",
  "jq",
  "du",
  "df",
  "env",
  "date",
  "basename",
  "dirname",
  "realpath",
  "true",
  "false",
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "describe",
  "grep",
  "shortlog",
  "cat-file",
  "remote",
]);

// Output redirection, command substitution, backgrounding, and heredocs can all write.
const UNSAFE_SHELL_SYNTAX = /[>`]|(?<!&)&(?!&)|\$\(|<<|<\(/;
const UNSAFE_FIND_FLAGS = /(^|\s)-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)\b/;

function isReadOnlySegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return true;
  const [command = "", sub = ""] = trimmed.split(/\s+/);
  if (command === "git") {
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub) && !/\s--output\b|\s-o\b/.test(trimmed);
  }
  if (command === "find" && UNSAFE_FIND_FLAGS.test(trimmed)) return false;
  if (command === "sort" && /\s-o\b|\s--output\b/.test(trimmed)) return false;
  if (command === "env" && trimmed !== "env") return false;
  return READ_ONLY_COMMANDS.has(command);
}

/** Conservative allowlist: anything not clearly read-only is treated as mutating. */
export function isMutatingShellCommand(command: string): boolean {
  if (UNSAFE_SHELL_SYNTAX.test(command)) return true;
  return !command.split(/\|\||&&|;|\||\n/).every((segment) => isReadOnlySegment(segment));
}

/** Returns a denial message when the partner read-only profile forbids this tool call. */
export function partnerReadOnlyDenial(toolName: string, toolInput: unknown): string | null {
  if (PARTNER_DISALLOWED_BUILTINS.has(toolName)) {
    return "Ask the user in your reply instead of using AskUserQuestion or ExitPlanMode.";
  }
  if (WRITE_TOOL_NAMES.has(toolName)) {
    return "Your workspace is read-only. Hand code changes to the developer instead of editing files.";
  }
  if (toolName === "Bash") {
    const command =
      toolInput !== null && typeof toolInput === "object"
        ? (toolInput as { command?: unknown }).command
        : undefined;
    if (typeof command !== "string" || isMutatingShellCommand(command)) {
      return "Your workspace is read-only. Only read-only shell commands are allowed; hand changes to the developer.";
    }
  }
  return null;
}
