// @effect-diagnostics nodeBuiltinImport:off -- pure path containment math, no I/O.
/**
 * HYBRID: the interim approval rule for developer (work-thread) requests.
 *
 * SUPERSEDED: the DelegationSupervisor now decides developer approvals through the
 * PolicyEngine (bots/policy). This allowlist is no longer called at runtime; it is kept
 * only for its tests until it is deleted.
 */
import * as NodePath from "node:path";

import type { ProviderRequestKind } from "@t3tools/contracts";

export interface DeveloperApprovalRequest {
  readonly requestKind: ProviderRequestKind | undefined;
  /** The command, path, or description the provider attached to the request. */
  readonly detail: string | undefined;
  /** Root of the worktree the developer works in. */
  readonly workspaceRoot: string;
}

export type DeveloperApprovalDecision =
  | { readonly decision: "accept" }
  | { readonly decision: "decline"; readonly reason: string };

const ACCEPT: DeveloperApprovalDecision = { decision: "accept" };

const decline = (reason: string): DeveloperApprovalDecision => ({ decision: "decline", reason });

const OUTSIDE_WORKTREE =
  "That touches a path outside the worktree. Stay inside the project folder.";

/** Shell punctuation that chains, pipes, redirects, backgrounds, or substitutes. `&&` is split off first. */
const UNSAFE_SHELL = /[;|<>&`\n\r]|\$\(|\$\{/;

const SAFE_ENV_ASSIGNMENT = /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG)=[\w.:-]*$/;

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun", "vp"]);
const PACKAGE_MANAGER_VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "--workspace",
  "-w",
  "--cwd",
  "-C",
  "--prefix",
  "--dir",
]);
const SAFE_SCRIPT =
  /^(?:test|t|build|typecheck|type-check|lint|check|compile|vitest)(?::[\w:-]+)?$/;
const CHECK_BINARIES = new Set([
  "vitest",
  "jest",
  "mocha",
  "tsc",
  "tsgo",
  "eslint",
  "oxlint",
  "pytest",
]);
const TOOL_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  go: new Set(["test", "build", "vet"]),
  cargo: new Set(["test", "build", "check", "clippy"]),
  make: new Set(["test", "build", "check", "lint"]),
  swift: new Set(["test", "build"]),
  dotnet: new Set(["test", "build"]),
  mvn: new Set(["test", "compile", "verify"]),
  gradle: new Set(["test", "build", "check"]),
  "./gradlew": new Set(["test", "build", "check"]),
  git: new Set(["status", "diff", "log", "show", "rev-parse"]),
};
const READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "rg", "grep"]);
/** Flags that let an otherwise read-only program write files or run other programs. */
const UNSAFE_READ_FLAG = /^--(?:output|pre|ext-diff|textconv|open-files-in-pager)(?:=|$)/;

/** Splits a command line into words, honouring single and double quotes. Null if a quote is open. */
function tokenize(input: string): ReadonlyArray<string> | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

/** True when a path-looking word resolves outside `root`. Plain words (flags, names) are not paths. */
function escapesRoot(word: string, root: string): boolean {
  const eq = word.startsWith("-") ? word.indexOf("=") : -1;
  const candidate = eq >= 0 ? word.slice(eq + 1) : word;
  if (candidate.startsWith("-")) return false;
  const isPath =
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate === ".." ||
    candidate.includes("../") ||
    candidate.includes("..\\");
  if (!isPath) return false;
  if (candidate.startsWith("~")) return true;
  const relative = NodePath.relative(root, NodePath.resolve(root, candidate));
  return (
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
  );
}

function wordsOfDescription(detail: string): ReadonlyArray<string> {
  return detail
    .split(/\s+/)
    .map((word) => word.replace(/^[`'"([{]+|[`'")\]},;:.]+$/g, ""))
    .filter((word) => word.length > 0);
}

function decidePathRequest(detail: string | undefined, root: string): DeveloperApprovalDecision {
  if (detail === undefined) return ACCEPT;
  return wordsOfDescription(detail).some((word) => escapesRoot(word, root))
    ? decline(OUTSIDE_WORKTREE)
    : ACCEPT;
}

/** The first non-option word after the runner, skipping flags that take a value. */
function nextSubcommand(args: ReadonlyArray<string>): { sub: string | undefined; rest: number } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return { sub: arg, rest: index + 1 };
    if (PACKAGE_MANAGER_VALUE_FLAGS.has(arg)) index += 1;
  }
  return { sub: undefined, rest: args.length };
}

function isCheckRunnerAllowed(runner: string, args: ReadonlyArray<string>): boolean {
  const { sub, rest } = nextSubcommand(args);
  if (sub === undefined) return false;
  if (SAFE_SCRIPT.test(sub)) return true;
  if (sub === "run" || sub === "run-script") {
    const script = nextSubcommand(args.slice(rest)).sub;
    return script !== undefined && SAFE_SCRIPT.test(script);
  }
  if (sub === "exec" || sub === "x") {
    const binary = nextSubcommand(args.slice(rest)).sub;
    return binary !== undefined && CHECK_BINARIES.has(binary);
  }
  // `vp` is the repo's own runner: its check/test/build subcommands are the same scripts.
  return runner === "vp" && sub === "check";
}

/** Null when the segment is an allowed read or check command, else the reason it is not. */
function declineSegment(tokens: ReadonlyArray<string>, root: string): string | null {
  let start = 0;
  while (start < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[start]!)) {
    if (!SAFE_ENV_ASSIGNMENT.test(tokens[start]!)) {
      return `Setting ${tokens[start]!.split("=")[0]} is not allowed. Run the command without it.`;
    }
    start += 1;
  }
  const program = tokens[start];
  if (program === undefined) return "That command is empty.";
  const args = tokens.slice(start + 1);

  if (args.some((arg) => escapesRoot(arg, root))) return OUTSIDE_WORKTREE;

  const name = program.startsWith("./node_modules/.bin/")
    ? program.slice("./node_modules/.bin/".length)
    : program;
  if (name.includes("/") && name !== "./gradlew") {
    return "Run tools by name, not by path.";
  }

  if (PACKAGE_MANAGERS.has(name)) {
    return isCheckRunnerAllowed(name, args)
      ? null
      : `${name} can only run test, build, typecheck, lint, or check scripts without approval. Installing or changing packages needs the user.`;
  }
  if (name === "npx" || name === "bunx") {
    const binary = nextSubcommand(args).sub;
    return binary !== undefined && CHECK_BINARIES.has(binary)
      ? null
      : `${name} can only run test or typecheck tools (vitest, jest, tsc, eslint, and similar).`;
  }
  if (CHECK_BINARIES.has(name)) return null;
  if (name === "prettier") {
    return args.includes("--check") ? null : "prettier is only allowed with --check.";
  }
  if ((name === "python" || name === "python3") && args[0] === "-m" && args[1] === "pytest") {
    return null;
  }
  const allowedSubcommands = TOOL_SUBCOMMANDS[name];
  if (allowedSubcommands !== undefined) {
    const sub = args[0];
    if (sub === undefined || !allowedSubcommands.has(sub)) {
      return `${name} ${sub ?? ""}`.trim() + " is not an allowed test, build, or read command.";
    }
    return args.some((arg) => UNSAFE_READ_FLAG.test(arg))
      ? `That ${name} option can write files or run other programs.`
      : null;
  }
  if (READ_COMMANDS.has(name)) {
    return args.some((arg) => UNSAFE_READ_FLAG.test(arg))
      ? `That ${name} option can write files or run other programs.`
      : null;
  }
  return `${name} is not a test, build, or read command, so it needs approval from the user.`;
}

function decideCommand(detail: string | undefined, root: string): DeveloperApprovalDecision {
  let command = detail?.trim() ?? "";
  if (command.length === 0) return decline("The command was empty or could not be read.");

  // Providers often wrap the real command: `/bin/zsh -lc 'pnpm test'`.
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(command);
  if (wrapped !== null) {
    const inner = tokenize(wrapped[1]!);
    if (inner === null || inner.length !== 1) {
      return decline("That shell wrapper could not be read. Run the command directly.");
    }
    command = inner[0]!.trim();
  }

  const segments = command.split("&&").map((segment) => segment.trim());
  for (const segment of segments) {
    if (segment.length === 0 || UNSAFE_SHELL.test(segment)) {
      return decline(
        "Piped, redirected, backgrounded, or substituted commands are not auto-approved. Run each test or build command on its own.",
      );
    }
    const tokens = tokenize(segment);
    if (tokens === null) return decline("That command has an unclosed quote.");
    const reason = declineSegment(tokens, root);
    if (reason !== null) return decline(reason);
  }
  return ACCEPT;
}

/**
 * The one place developer approvals are decided. Phase 5 replaces this with the
 * PolicyEngine; callers pass what the provider asked for and get a decision, plus
 * a reason on decline that is relayed to the developer.
 */
export function decideDeveloperApproval(
  request: DeveloperApprovalRequest,
): DeveloperApprovalDecision {
  switch (request.requestKind) {
    case "file-read":
    case "file-change":
      return decidePathRequest(request.detail, request.workspaceRoot);
    case "command":
      return decideCommand(request.detail, request.workspaceRoot);
    case "mcp-elicitation":
    case "permission":
      return decline(
        "App and permission requests are not available while you work. Continue without it, or say what you need and your partner will decide.",
      );
    default:
      return decline("That kind of request is not available while you work.");
  }
}
