// @effect-diagnostics nodeBuiltinImport:off -- pure path containment math, no I/O.
import * as NodePath from "node:path";

import type { ApprovalClass } from "@t3tools/contracts";
import type { ProviderRequestKind } from "@t3tools/contracts";

export type ClassifyInput = {
  readonly requestKind: ProviderRequestKind | undefined;
  readonly detail: string | undefined;
  readonly workspaceRoot: string;
};

const RESTRICTION_ORDER: readonly ApprovalClass[] = [
  "secrets",
  "outside-workspace",
  "production",
  "opaque",
  "send",
  "delete",
  "install",
  "none",
];

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
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
const INSTALL_SUBCOMMANDS = new Set(["install", "add", "i", "ci"]);

const pickMostRestrictive = (classes: ReadonlyArray<ApprovalClass>): ApprovalClass => {
  const set = new Set(classes);
  for (const klass of RESTRICTION_ORDER) {
    if (set.has(klass)) return klass;
  }
  return "none";
};

/** A shell word, and whether any of it was quoted. */
type Word = { readonly value: string; readonly quoted: boolean };

function tokenizeWords(input: string): ReadonlyArray<Word> | null {
  const words: Word[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let quoted = false;
  let inToken = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        words.push({ value: current, quoted });
        current = "";
        quoted = false;
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote !== null) return null;
  if (inToken) words.push({ value: current, quoted });
  return words;
}

function tokenize(input: string): ReadonlyArray<string> | null {
  return tokenizeWords(input)?.map((word) => word.value) ?? null;
}

/** Flags whose value is prose (a commit message, a PR title), never a path. */
const PROSE_VALUE_FLAGS = new Set(["-m", "--message", "--body", "--title", "-t", "-b"]);
const PROSE_VALUE_FLAG_PROGRAMS = new Set(["git", "gh", "glab", "hg", "jj", "svn"]);

/**
 * HYBRID: the words a command part's class is read from. Message values and quoted prose
 * (a quoted argument with spaces that does not look like a path) are dropped, so a commit
 * message that mentions "credentials" or ".env" is not a secrets path. Heredoc bodies were
 * already removed by the splitter; `-F <file>` keeps its file, which is a real path.
 */
function classifiableTokens(words: ReadonlyArray<Word>): ReadonlyArray<string> {
  let start = 0;
  while (start < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[start]!.value)) start += 1;
  const program = normalizeProgram(words[start]?.value ?? "");
  const proseFlags = PROSE_VALUE_FLAG_PROGRAMS.has(program);
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const value = word.value;
    if (proseFlags && index > start) {
      const eq = value.startsWith("--") ? value.indexOf("=") : -1;
      if (eq >= 0 && PROSE_VALUE_FLAGS.has(value.slice(0, eq))) {
        kept.push(value.slice(0, eq));
        continue;
      }
      // `-m msg`, and short clusters ending in m such as `git commit -am msg`.
      if (PROSE_VALUE_FLAGS.has(value) || (program === "git" && /^-[a-zA-Z]+m$/.test(value))) {
        kept.push(value);
        index += 1;
        continue;
      }
    }
    if (word.quoted && /\s/.test(value) && !isPathLike(value)) continue;
    // `>.env`, `2>>log`: the redirect target is the path.
    kept.push(value.replace(/^\d*[<>]+&?/, ""));
  }
  return kept;
}

function pathValueFromWord(word: string): string {
  const eq = word.startsWith("-") ? word.indexOf("=") : -1;
  return eq >= 0 ? word.slice(eq + 1) : word;
}

function isPathLike(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate === ".." ||
    candidate.includes("../") ||
    candidate.includes("..\\") ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.startsWith(".")
  );
}

function escapesRoot(word: string, root: string): boolean {
  const candidate = pathValueFromWord(word);
  if (candidate.startsWith("-")) return false;
  if (!isPathLike(candidate)) return false;
  if (candidate.startsWith("~")) return true;
  const relative = NodePath.relative(root, NodePath.resolve(root, candidate));
  return (
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
  );
}

function pathIndicatesSecrets(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)\.env[\w.-]*/.test(normalized)) return true;
  if (/(^|\/)\.ssh(\/|$)/.test(normalized) || normalized.includes("/.ssh")) return true;
  if (/(^|\/)\.aws(\/|$)/.test(normalized) || normalized.includes("/.aws")) return true;
  if (/credentials/i.test(normalized)) return true;
  if (/keychain/i.test(normalized)) return true;
  return false;
}

function wordsOfDescription(detail: string): ReadonlyArray<string> {
  return detail
    .split(/\s+/)
    .map((word) => word.replace(/^[`'"([{]+|[`'")\]},;:.]+$/g, ""))
    .filter((word) => word.length > 0);
}

function pathClassesForWord(word: string, root: string): ReadonlyArray<ApprovalClass> {
  const classes: ApprovalClass[] = [];
  const candidate = pathValueFromWord(word);
  if (pathIndicatesSecrets(candidate) || pathIndicatesSecrets(word)) {
    classes.push("secrets");
  }
  if (isPathLike(candidate) && escapesRoot(word, root)) {
    classes.push("outside-workspace");
  }
  return classes;
}

function classifyPathDetail(detail: string | undefined, root: string): ApprovalClass {
  if (detail === undefined || detail.trim().length === 0) return "none";
  const classes: ApprovalClass[] = [];
  if (pathIndicatesSecrets(detail)) classes.push("secrets");
  for (const word of wordsOfDescription(detail)) {
    classes.push(...pathClassesForWord(word, root));
  }
  return classes.length === 0 ? "none" : pickMostRestrictive(classes);
}

function nextSubcommand(args: ReadonlyArray<string>): { sub: string | undefined; rest: number } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return { sub: arg, rest: index + 1 };
    if (PACKAGE_MANAGER_VALUE_FLAGS.has(arg)) index += 1;
  }
  return { sub: undefined, rest: args.length };
}

function normalizeProgram(program: string): string {
  return program.startsWith("./node_modules/.bin/")
    ? program.slice("./node_modules/.bin/".length)
    : program;
}

function curlMethodIsPost(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-X" || arg === "--request") {
      const method = args[index + 1];
      if (method !== undefined && method.toUpperCase() === "POST") return true;
    }
    if (/^-XPOST$/i.test(arg)) return true;
    if (arg.startsWith("-X") && arg.length > 2 && arg.slice(2).toUpperCase() === "POST") {
      return true;
    }
    if (
      arg === "-d" ||
      arg === "--data" ||
      arg === "--data-binary" ||
      arg === "--data-raw" ||
      arg === "--data-urlencode" ||
      arg === "--json" ||
      arg.startsWith("-d") ||
      arg.startsWith("--data=")
    ) {
      return true;
    }
  }
  return false;
}

function detailIndicatesSend(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    lower.includes("hooks.slack.com") ||
    lower.includes("slack.com/api") ||
    lower.includes("webhook")
  );
}

function classifyCommandTokens(
  tokens: ReadonlyArray<string>,
  root: string,
): ReadonlyArray<ApprovalClass> {
  const classes: ApprovalClass[] = [];
  let start = 0;
  while (start < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[start]!)) {
    start += 1;
  }
  const program = tokens[start];
  if (program === undefined) return ["none"];
  const args = tokens.slice(start + 1);
  const name = normalizeProgram(program);

  for (const arg of args) {
    classes.push(...pathClassesForWord(arg, root));
  }
  for (const token of tokens) {
    if (token.toLowerCase() === "drop") classes.push("delete");
  }

  if (name === "rm") classes.push("delete");
  if (name === "kubectl") classes.push("production");
  if (name === "deploy") classes.push("production");

  if (name === "git") {
    const { sub } = nextSubcommand(args);
    if (sub === "push") classes.push("production");
    if (sub === "clean") classes.push("delete");
    if (sub === "reset" && args.includes("--hard")) classes.push("delete");
  }

  if (name === "terraform" && args.includes("apply")) classes.push("production");

  if (name === "gh") {
    const { sub, rest } = nextSubcommand(args);
    if (sub === "pr" && args.slice(rest).includes("merge")) classes.push("production");
  }

  if (name === "publish" || args.includes("publish")) classes.push("production");
  if (args.includes("deploy")) classes.push("production");

  if (PACKAGE_MANAGERS.has(name)) {
    const { sub } = nextSubcommand(args);
    if (sub !== undefined && INSTALL_SUBCOMMANDS.has(sub)) classes.push("install");
  }

  if (name === "curl" && curlMethodIsPost(args)) classes.push("send");
  if (name === "mail" || name === "mailx" || name === "sendmail") classes.push("send");

  return classes;
}

// HYBRID: compound commands are split into parts; each part is classified and keyed on its own.
/** One simple command from a compound line, with heredoc bodies removed. */
export interface CommandPart {
  readonly text: string;
  readonly approvalClass: ApprovalClass;
  /** Normalized command + target that an Always-allow rule stores and matches. */
  readonly key: string;
}

type ScanContext = "'" | '"' | "`" | "(";

/** Reads a heredoc delimiter starting at `index` (just after `<<` / `<<-`). */
function readHeredocDelimiter(
  input: string,
  index: number,
): { readonly delimiter: string; readonly end: number } | null {
  let cursor = index;
  while (cursor < input.length && (input[cursor] === " " || input[cursor] === "\t")) cursor += 1;
  let delimiter = "";
  while (cursor < input.length && !/[\s;&|<>()]/.test(input[cursor]!)) {
    const char = input[cursor]!;
    if (char === "'" || char === '"') {
      const close = input.indexOf(char, cursor + 1);
      if (close < 0) return null;
      delimiter += input.slice(cursor + 1, close);
      cursor = close + 1;
      continue;
    }
    if (char === "\\") {
      cursor += 1;
      if (cursor < input.length) delimiter += input[cursor]!;
      cursor += 1;
      continue;
    }
    delimiter += char;
    cursor += 1;
  }
  return delimiter.length === 0 ? null : { delimiter, end: cursor };
}

/**
 * Splits a shell line on `&&`, `||`, `;`, `|`, and newlines that sit outside quotes,
 * `$(...)`, backticks, and heredoc bodies. Heredoc bodies are dropped from the parts.
 */
export function splitShellCommand(input: string): ReadonlyArray<string> {
  const parts: string[] = [];
  const stack: ScanContext[] = [];
  const pendingHeredocs: Array<{ readonly delimiter: string; readonly stripTabs: boolean }> = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) parts.push(trimmed);
    current = "";
  };
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    const top = stack.at(-1);

    if (top === "'") {
      current += char;
      if (char === "'") stack.pop();
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < input.length) {
      current += char + input[index + 1]!;
      index += 2;
      continue;
    }
    if (top === '"') {
      if (char === '"') stack.pop();
      else if (char === "$" && input[index + 1] === "(") {
        stack.push("(");
        current += "$(";
        index += 2;
        continue;
      } else if (char === "`") stack.push("`");
      current += char;
      index += 1;
      continue;
    }

    if (char === "\n" && pendingHeredocs.length > 0) {
      // Skip each heredoc body through its delimiter line.
      let cursor = index + 1;
      for (const heredoc of pendingHeredocs) {
        while (cursor <= input.length) {
          const lineEnd = input.indexOf("\n", cursor);
          const stop = lineEnd < 0 ? input.length : lineEnd;
          const line = input.slice(cursor, stop);
          cursor = stop + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
          if (lineEnd < 0) break;
        }
      }
      pendingHeredocs.length = 0;
      if (stack.length === 0) flush();
      else current += "\n";
      index = cursor;
      continue;
    }

    if (char === "<" && input[index + 1] === "<" && input[index + 2] !== "<") {
      const stripTabs = input[index + 2] === "-";
      const read = readHeredocDelimiter(input, index + (stripTabs ? 3 : 2));
      if (read !== null) {
        pendingHeredocs.push({ delimiter: read.delimiter, stripTabs });
        current += input.slice(index, read.end);
        index = read.end;
        continue;
      }
    }

    if (char === "'" || char === '"') {
      stack.push(char);
    } else if (char === "`") {
      if (top === "`") stack.pop();
      else stack.push("`");
    } else if (char === "$" && input[index + 1] === "(") {
      stack.push("(");
      current += "$(";
      index += 2;
      continue;
    } else if (char === "(" && stack.length > 0) {
      stack.push("(");
    } else if (char === ")" && top === "(") {
      stack.pop();
    } else if (stack.length === 0) {
      const two = input.slice(index, index + 2);
      if (two === "&&" || two === "||" || two === "|&") {
        flush();
        index += 2;
        continue;
      }
      if (char === ";" || char === "|" || char === "\n") {
        flush();
        index += 1;
        continue;
      }
    }
    current += char;
    index += 1;
  }
  flush();
  return parts;
}

/** `bash -lc "<one command line>"` → the inner line; anything else is returned as is. */
function unwrapShell(command: string): string | null {
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(command);
  if (wrapped === null) return command;
  const inner = tokenize(wrapped[1]!);
  if (inner === null || inner.length !== 1) return null;
  return inner[0]!.trim();
}

const quoteKeyToken = (token: string): string =>
  /[\s'"]/.test(token) ? `'${token.replace(/'/g, "'\\''")}'` : token;

/** Flag values that are messages or payloads, not targets. Dropped from rule keys. */
const VALUE_FLAGS_DROPPED: Readonly<Record<string, ReadonlySet<string>>> = {
  curl: new Set([
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--data-ascii",
    "--json",
    "-H",
    "--header",
    "-F",
    "--form",
    "-u",
    "--user",
    "-A",
    "--user-agent",
    "-b",
    "--cookie",
    "-e",
    "--referer",
  ]),
};
const MESSAGE_FLAGS = new Set(["-m", "--message"]);

/** git push flags that don't change what is pushed where. */
const GIT_PUSH_IGNORED_FLAGS = new Set([
  "-u",
  "--set-upstream",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--progress",
  "--no-progress",
  "--porcelain",
]);
const GIT_PUSH_SHORT_FLAGS: Readonly<Record<string, string>> = { f: "-f", d: "--delete" };

function gitPushKey(args: ReadonlyArray<string>, currentBranch: string | undefined): string {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-o" || arg === "--push-option" || arg === "--repo" || arg === "--receive-pack") {
      flags.add(`${arg} ${quoteKeyToken(args[index + 1] ?? "")}`.trim());
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      // --force, --force-with-lease, --delete, --tags, ... stay part of the key.
      const name = arg.startsWith("--force-with-lease") ? "--force-with-lease" : arg;
      if (!GIT_PUSH_IGNORED_FLAGS.has(name)) flags.add(name);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        const flag = `-${letter}`;
        if (GIT_PUSH_IGNORED_FLAGS.has(flag)) continue;
        flags.add(GIT_PUSH_SHORT_FLAGS[letter] ?? flag);
      }
      continue;
    }
    positionals.push(arg);
  }
  const [remote, ...refs] = positionals;
  const resolvedRefs =
    remote === undefined
      ? []
      : refs.length === 0
        ? currentBranch === undefined
          ? []
          : [currentBranch]
        : refs.map((ref) => (ref === "HEAD" && currentBranch !== undefined ? currentBranch : ref));
  const targets = [...(remote === undefined ? [] : [remote]), ...resolvedRefs].map(quoteKeyToken);
  return ["git", "push", ...[...flags].toSorted(), ...targets].join(" ");
}

/** Command + target: env assignments, messages, and payload values are left out. */
function ruleKeyForTokens(
  tokens: ReadonlyArray<string>,
  currentBranch: string | undefined,
): string {
  let start = 0;
  while (start < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[start]!)) start += 1;
  const program = tokens[start];
  if (program === undefined) return "";
  const name = normalizeProgram(program);
  const args = tokens.slice(start + 1);
  if (name === "git") {
    const { sub, rest } = nextSubcommand(args);
    if (sub === "push") return gitPushKey(args.slice(rest), currentBranch);
  }
  const dropped = VALUE_FLAGS_DROPPED[name] ?? MESSAGE_FLAGS;
  const kept: string[] = [name];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flagName = eq >= 0 ? arg.slice(0, eq) : arg;
    if (dropped.has(flagName) || MESSAGE_FLAGS.has(flagName)) {
      kept.push(flagName);
      if (eq < 0) index += 1;
      continue;
    }
    kept.push(arg);
  }
  return kept.map(quoteKeyToken).join(" ");
}

/** The branch a `git checkout -b x` / `git switch x` part leaves the shell on, if any. */
function branchAfter(tokens: ReadonlyArray<string>): string | undefined {
  if (normalizeProgram(tokens[0] ?? "") !== "git") return undefined;
  const sub = tokens[1];
  if (sub !== "checkout" && sub !== "switch") return undefined;
  const positionals = tokens.slice(2).filter((token) => !token.startsWith("-"));
  const create = tokens.find(
    (token) => token === "-b" || token === "-B" || token === "-c" || token === "-C",
  );
  if (create !== undefined) return tokens[tokens.indexOf(create) + 1];
  return positionals.length === 1 ? positionals[0] : undefined;
}

// HYBRID: wrappers hide the real action. Unwrap them and classify what they run;
// fail closed (opaque) when the action can't be read.
const MAX_WRAPPER_DEPTH = 4;

/** Wrappers that run the rest of their arguments as a command, with their value flags. */
const PREFIX_WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-D"]),
  nohup: new Set(),
  time: new Set(["-f", "--format", "-o", "--output"]),
  command: new Set(),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set([
    "-n",
    "--max-args",
    "-I",
    "-i",
    "-L",
    "--max-lines",
    "-P",
    "--max-procs",
    "-d",
    "--delimiter",
    "-E",
    "-e",
    "-s",
    "--max-chars",
    "-a",
    "--arg-file",
  ]),
  watch: new Set(["-n", "--interval", "-d", "--differences", "-g", "--chgexit"]),
  npx: new Set(["-p", "--package", "-c", "--call"]),
  pnpx: new Set(["-p", "--package"]),
  bunx: new Set(["-p", "--package"]),
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Interpreters and the flags that make them run inline code. */
const INLINE_CODE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(["-c"]),
  python2: new Set(["-c"]),
  python3: new Set(["-c"]),
  node: new Set(["-e", "--eval", "-p", "--print"]),
  ruby: new Set(["-e"]),
  perl: new Set(["-e", "-E"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  zx: new Set(["-e", "--eval"]),
  osascript: new Set(["-e"]),
  php: new Set(["-r"]),
};

/** ssh flags that take a value; the first other word is the host. */
const SSH_VALUE_FLAGS = new Set([
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-E",
  "-b",
  "-c",
  "-e",
  "-m",
  "-O",
  "-Q",
  "-S",
  "-W",
  "-w",
  "-B",
]);

const isRemoteSpec = (word: string) => /^[^\s/:]+@[^\s/:]+/.test(word) || /^[^\s/:]+:/.test(word);

/** Strips a wrapper's own flags (and their values) and leading VAR=val words. */
function afterWrapperFlags(
  words: ReadonlyArray<Word>,
  valueFlags: ReadonlySet<string>,
  name: string,
): ReadonlyArray<Word> {
  let index = 0;
  while (index < words.length) {
    const value = words[index]!.value;
    if (value === "--") {
      index += 1;
      break;
    }
    if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-") || value === "-") break;
    index += valueFlags.has(value) ? 2 : 1;
  }
  const rest = words.slice(index);
  // `timeout 60 cmd`, `nice 10 cmd`: a leading number is the wrapper's own argument.
  if ((name === "timeout" || name === "nice") && rest.length > 1 && /^\d/.test(rest[0]!.value)) {
    return rest.slice(1);
  }
  return rest;
}

/** A shell payload (`bash -c "..."`, `eval ...`): split and classify like a command line. */
function classifyPayload(payload: string, root: string, depth: number): ApprovalClass {
  const parts = splitShellCommand(payload);
  if (parts.length === 0) return "none";
  return pickMostRestrictive(parts.map((part) => classifySegmentAt(part, root, depth + 1)));
}

function classifyWords(words: ReadonlyArray<Word>, root: string, depth: number): ApprovalClass {
  if (depth > MAX_WRAPPER_DEPTH) return "opaque";
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!.value)) start += 1;
  const program = words[start];
  if (program === undefined) return "none";
  const name = normalizeProgram(program.value).replace(/^.*\//, "");
  const args = words.slice(start + 1);

  const wrapperFlags = PREFIX_WRAPPERS[name];
  if (wrapperFlags !== undefined) {
    const inner = afterWrapperFlags(args, wrapperFlags, name);
    return inner.length === 0 ? "none" : classifyWords(inner, root, depth + 1);
  }

  if (name === "eval") {
    return classifyPayload(args.map((word) => word.value).join(" "), root, depth);
  }

  if (SHELLS.has(name)) {
    const flagIndex = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word.value));
    if (flagIndex >= 0) {
      const payload = args[flagIndex + 1];
      return payload === undefined ? "none" : classifyPayload(payload.value, root, depth);
    }
  }

  if (name === "ssh") {
    let index = 0;
    while (index < args.length && args[index]!.value.startsWith("-")) {
      index += SSH_VALUE_FLAGS.has(args[index]!.value) ? 2 : 1;
    }
    if (index < args.length) {
      // Anything run on another machine always asks, whatever it is.
      const remote = args
        .slice(index + 1)
        .map((word) => word.value)
        .join(" ");
      const inner = remote.length > 0 ? classifyPayload(remote, NodePath.sep, depth) : "none";
      return pickMostRestrictive(["production", inner === "outside-workspace" ? "none" : inner]);
    }
  }

  if ((name === "scp" || name === "rsync") && args.some((word) => isRemoteSpec(word.value))) {
    return pickMostRestrictive(["production", classifyTerminal(words.slice(start), root)]);
  }

  const inlineFlags = INLINE_CODE_FLAGS[name];
  if (
    (inlineFlags !== undefined &&
      args.some((word) => inlineFlags.has(word.value) || /^--(eval|print)=/.test(word.value))) ||
    (name === "deno" && args[0]?.value === "eval")
  ) {
    return "opaque";
  }

  return classifyTerminal(words.slice(start), root);
}

/** A plain command: classify its real arguments (messages and prose dropped). */
function classifyTerminal(words: ReadonlyArray<Word>, root: string): ApprovalClass {
  const classes: ApprovalClass[] = [];
  const tokens = classifiableTokens(words);
  if (tokens.some(pathIndicatesSecrets)) classes.push("secrets");
  if (detailIndicatesSend(tokens.join(" "))) classes.push("send");
  classes.push(...classifyCommandTokens(tokens, root));
  return classes.length === 0 ? "none" : pickMostRestrictive(classes);
}

function classifySegmentAt(segment: string, root: string, depth: number): ApprovalClass {
  const words = tokenizeWords(segment);
  if (words === null) {
    // Unbalanced quotes: nothing to separate prose from paths, so read the whole text.
    const classes: ApprovalClass[] = [];
    if (pathIndicatesSecrets(segment)) classes.push("secrets");
    if (detailIndicatesSend(segment)) classes.push("send");
    return classes.length === 0 ? "none" : pickMostRestrictive(classes);
  }
  return classifyWords(words, root, depth);
}

function classifySegment(segment: string, root: string): ApprovalClass {
  return classifySegmentAt(segment, root, 0);
}

/** Splits a command line and classifies and keys each part. */
export function classifyCommandParts(
  detail: string | undefined,
  root: string,
): ReadonlyArray<CommandPart> {
  const trimmed = detail?.trim() ?? "";
  if (trimmed.length === 0) return [];
  const command = unwrapShell(trimmed);
  if (command === null) {
    // A wrapper we cannot read is one opaque part.
    return [
      { text: trimmed, approvalClass: classifySegment(trimmed, root), key: normalizeKey(trimmed) },
    ];
  }
  let currentBranch: string | undefined;
  return splitShellCommand(command).map((text) => {
    const tokens = tokenize(text);
    const key = tokens === null ? normalizeKey(text) : ruleKeyForTokens(tokens, currentBranch);
    if (tokens !== null) currentBranch = branchAfter(tokens) ?? currentBranch;
    return { text, approvalClass: classifySegment(text, root), key };
  });
}

const normalizeKey = (text: string): string => text.trim().replace(/\s+/g, " ");

/**
 * The parts an approval is made of. Commands split into their simple commands; a path
 * request is one part keyed on the path.
 */
export function approvalParts(input: ClassifyInput): ReadonlyArray<CommandPart> {
  switch (input.requestKind) {
    case "command":
      return classifyCommandParts(input.detail, input.workspaceRoot);
    case "file-read":
    case "file-change": {
      const detail = input.detail?.trim() ?? "";
      if (detail.length === 0) return [];
      return [
        {
          text: detail,
          approvalClass: classifyPathDetail(detail, input.workspaceRoot),
          key: normalizeKey(detail),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Re-normalizes a stored rule's matchDetail into the keys it covers. Rules saved before
 * parts existed hold a whole chained line; only its non-`none` parts are kept. Keys are
 * themselves single parts, so this is idempotent.
 */
export function ruleMatchKeys(matchDetail: string): ReadonlyArray<string> {
  const parts = classifyCommandParts(matchDetail, NodePath.sep);
  if (parts.length > 1) {
    return parts.filter((part) => part.approvalClass !== "none").map((part) => part.key);
  }
  // A single command or a path: keep the stored text, plus its command key.
  return [...new Set([normalizeKey(matchDetail), ...parts.map((part) => part.key)])].filter(
    (key) => key.length > 0,
  );
}

function classifyCommandDetail(detail: string | undefined, root: string): ApprovalClass {
  const parts = classifyCommandParts(detail, root);
  return parts.length === 0 ? "none" : pickMostRestrictive(parts.map((part) => part.approvalClass));
}

export function classifyApprovalRequest(input: ClassifyInput): ApprovalClass {
  switch (input.requestKind) {
    case "file-read":
    case "file-change":
      return classifyPathDetail(input.detail, input.workspaceRoot);
    case "command":
      return classifyCommandDetail(input.detail, input.workspaceRoot);
    case "mcp-elicitation":
    case "permission":
      return "production";
    default:
      return "production";
  }
}
