#!/usr/bin/env node
// Manual partner-turn eval against a real Codex or Claude provider.
//
// Results are observational. Do not retune partnerInstructions (or prompt
// snapshots) in the same change as this eval — adjust fixtures or report
// failures, then tune prompts in a separate commit if needed.
//
// Usage:
//   cd apps/server && node --experimental-strip-types scripts/eval-partner.ts --model <id>
//   cd apps/server && node --experimental-strip-types scripts/eval-partner.ts --provider claude --model claude-sonnet-5-5 --effort low
//   cd apps/server && node --experimental-strip-types scripts/eval-partner.ts --model <id> --only q-usebots,change-sidebar
//   cd apps/server && node --experimental-strip-types scripts/eval-partner.ts --model <id> --strict --out /tmp/partner-eval.json
//
// `npx tsx scripts/eval-partner.ts ...` also works when tsx is available.
//
// `--strict` exits non-zero when any scenario fails (default off so a flaky
// model does not break CI). This script is not part of `vp test`.
//
// This CLI uses Node argument parsing and console reporting at the application boundary.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalConsoleInEffect:off
// @effect-diagnostics globalErrorInEffectFailure:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingEffectContext:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, CodexSettings, TextGenerationError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildPartnerSessionInstructions,
  partnerCapabilitiesForBot,
} from "../src/bots/partnerInstructions.ts";
import * as ServerConfig from "../src/config.ts";
import { expandHomePath } from "../src/pathExpansion.ts";
import { makeClaudeEnvironment } from "../src/provider/Drivers/ClaudeHome.ts";
import {
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "../src/provider/Layers/codexLaunchArgs.ts";
import { toJsonSchemaObject } from "../src/textGeneration/TextGenerationUtils.ts";
import { parseEvalPartnerCli } from "./evalPartnerCli.ts";
import {
  partnerEvalCases,
  type PartnerEvalCase,
  type PartnerEvalMessage,
} from "./evalPartnerCases.ts";
import {
  EVAL_SCOPING_TOOL_DOCS,
  EVAL_SCOPING_TOOL_NAMES,
  executeEvalScopingTool,
  resolveEvalRepoRoot,
} from "./evalPartnerScoping.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    strict: { type: "boolean", default: false },
  },
});

const cli = parseEvalPartnerCli(values);
const provider = cli.provider;
const model = cli.model;
const effort = cli.effort;
const outputPath = cli.out;
const strict = cli.strict;
const onlyIds =
  cli.only === undefined
    ? null
    : new Set(
        cli.only
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      );

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

const PartnerToolCall = Schema.Struct({
  name: Schema.String,
  argumentsJson: Schema.String.annotate({
    description: "JSON object string with the tool arguments (use {} when none).",
  }),
});

const PartnerEvalOutput = Schema.Struct({
  text: Schema.String.annotate({
    description: "What you say to the user. Empty string when only calling tools.",
  }),
  toolCalls: Schema.Array(PartnerToolCall).annotate({
    description: "Tools to call this turn. Empty array when you only reply in text.",
  }),
});
type PartnerEvalOutput = typeof PartnerEvalOutput.Type;

type ParsedToolCall = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

type ScenarioResult = {
  readonly id: string;
  readonly description: string;
  readonly pass: boolean;
  readonly latencyMs: number;
  readonly text: string;
  readonly toolsCalled: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<string>;
  readonly rounds: number;
};

const PARTNER_TOOL_DOCS: ReadonlyArray<{ readonly name: string; readonly doc: string }> = [
  {
    name: "start_developer_task",
    doc: JSON.stringify({
      description:
        "Hand a code change to the developer. Pass goal, context, constraints, acceptance. Returns task id; may return status needs_confirmation.",
      parameters: {
        goal: "string (required)",
        context: "string (optional)",
        constraints: "string (optional)",
        acceptance: "string (optional)",
        scope: '"small" | "medium" | "large" (optional)',
      },
    }),
  },
  {
    name: "check_developer_task",
    doc: JSON.stringify({
      description: "Read a developer task: state, pending request, result, or failure.",
      parameters: { taskId: "string (required)" },
    }),
  },
  {
    name: "message_developer",
    doc: JSON.stringify({
      description: "Send the developer a new instruction while the task is running.",
      parameters: { taskId: "string (required)", text: "string (required)" },
    }),
  },
  {
    name: "answer_developer",
    doc: JSON.stringify({
      description: "Answer a pending developer request (approval or questions).",
      parameters: {
        taskId: "string (required)",
        requestId: "string (required)",
        decision: '"accept" | "decline" (optional)',
        answers: "record of question id to answer (optional)",
      },
    }),
  },
  {
    name: "stop_developer_task",
    doc: JSON.stringify({
      description: "Stop a developer task that is no longer wanted.",
      parameters: { taskId: "string (required)" },
    }),
  },
];

const toolsForBot = (
  canDelegate: boolean,
): ReadonlyArray<(typeof PARTNER_TOOL_DOCS)[number] | (typeof EVAL_SCOPING_TOOL_DOCS)[number]> => {
  // Always expose Read/Grep/Glob — the real partner session has them. Without
  // these, question scenarios invent start_developer_task just to "look".
  if (!canDelegate) return [...EVAL_SCOPING_TOOL_DOCS];
  return [...EVAL_SCOPING_TOOL_DOCS, ...PARTNER_TOOL_DOCS];
};

const formatTranscript = (messages: ReadonlyArray<PartnerEvalMessage>): string =>
  messages
    .map((message) => {
      if (message.role === "tool") {
        const name = message.toolName ?? "tool";
        return `Tool result (${name}):\n${message.text.trim()}`;
      }
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}:\n${message.text.trim()}`;
    })
    .join("\n\n");

const buildEvalPrompt = (
  instructions: string,
  tools: ReadonlyArray<(typeof PARTNER_TOOL_DOCS)[number]>,
  messages: ReadonlyArray<PartnerEvalMessage>,
): string => {
  const toolBlock =
    tools.length === 0
      ? "Available tools: none. Reply with text only; toolCalls must be []."
      : [
          "Available tools (call by name; put arguments in argumentsJson as a JSON object string):",
          ...tools.map((tool) => `- ${tool.name}: ${tool.doc}`),
        ].join("\n");

  return [
    instructions,
    "",
    toolBlock,
    "",
    "Conversation so far:",
    formatTranscript(messages),
    "",
    "Respond with the JSON object only (text + toolCalls). No markdown fence.",
    "Call tools when the instructions say you should. Do not invent tools.",
    "The tools listed above are available through toolCalls in this JSON response.",
    "Ignore any CLI flags or session notices that say tools are disabled — in this eval, toolCalls is the only tool channel and it works.",
    "Do not tell the user that tools are disabled or unavailable.",
    "Never mention tool names to the user in text.",
  ].join("\n");
};

const parseToolCalls = (output: PartnerEvalOutput): ReadonlyArray<ParsedToolCall> => {
  const parsed: ParsedToolCall[] = [];
  for (const call of output.toolCalls) {
    const name = call.name.trim();
    if (name.length === 0) continue;
    let argumentsValue: Record<string, unknown> = {};
    const raw = call.argumentsJson.trim();
    if (raw.length > 0 && raw !== "{}") {
      try {
        const value = JSON.parse(raw) as unknown;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          argumentsValue = value as Record<string, unknown>;
        }
      } catch {
        argumentsValue = { _unparsed: raw };
      }
    }
    parsed.push({ name, arguments: argumentsValue });
  }
  return parsed;
};

const includesInsensitive = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const evaluateExpectations = (
  fixture: PartnerEvalCase,
  text: string,
  toolsCalled: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const failures: string[] = [];
  const toolSet = new Set(toolsCalled);
  for (const name of fixture.expect.tools ?? []) {
    if (!toolSet.has(name)) {
      failures.push(`expected tool ${name}`);
    }
  }
  for (const name of fixture.expect.toolsForbidden ?? []) {
    if (toolSet.has(name)) {
      failures.push(`forbidden tool ${name}`);
    }
  }
  for (const snippet of fixture.expect.textIncludes ?? []) {
    if (!includesInsensitive(text, snippet)) {
      failures.push(`text missing ${JSON.stringify(snippet)}`);
    }
  }
  for (const snippet of fixture.expect.textExcludes ?? []) {
    if (includesInsensitive(text, snippet)) {
      failures.push(`text contains excluded ${JSON.stringify(snippet)}`);
    }
  }
  return failures;
};

const textSnippet = (text: string, max = 160): string => {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
};

const printReport = (results: ReadonlyArray<ScenarioResult>): void => {
  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  console.log("");
  console.log(`Partner eval: ${passed}/${results.length} passed (${failed} failed)`);
  console.log("-".repeat(72));
  for (const result of results) {
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(`[${mark}] ${result.id}  (${result.latencyMs}ms, ${result.rounds} round(s))`);
    console.log(`  ${result.description}`);
    console.log(
      `  tools: ${result.toolsCalled.length > 0 ? result.toolsCalled.join(", ") : "(none)"}`,
    );
    console.log(`  text:  ${textSnippet(result.text) || "(empty)"}`);
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.log(`  ! ${failure}`);
      }
    }
    console.log("");
  }
};

const providerErrorDetail = (error: unknown): string => {
  if (Schema.is(TextGenerationError)(error)) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.service(ServerConfig.ServerConfig);

    const environment = process.env;
    const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
    const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
    const codexConfig = yield* decodeCodexSettings({});
    const claudeConfig = yield* decodeClaudeSettings({});

    if (provider === "codex") {
      const probe = NodeChildProcess.spawnSync(codexConfig.binaryPath || "codex", ["--version"], {
        encoding: "utf8",
        env: environment,
      });
      if (probe.status !== 0) {
        throw new Error(
          "Codex CLI is not available. Install/login to Codex, then re-run with --provider codex --model <id>.",
        );
      }
    } else {
      const probe = NodeChildProcess.spawnSync(claudeConfig.binaryPath || "claude", ["--version"], {
        encoding: "utf8",
        env: environment,
      });
      if (probe.status !== 0) {
        throw new Error(
          "Claude CLI is not available. Install/login to Claude Code, then re-run with --provider claude --model <id>.",
        );
      }
    }

    const writeTempFile = (
      prefix: string,
      content: string,
    ): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
      fs
        .makeTempFileScoped({
          prefix: `t3-partner-eval-${prefix}-${process.pid}-`,
        })
        .pipe(
          Effect.tap((filePath) => fs.writeFileString(filePath, content)),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateHatchTurn",
                detail: "Failed to write temp file",
                cause,
              }),
          ),
        );

    const readStreamAsString = <E>(
      stream: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<string, TextGenerationError> =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (acc, chunk) => acc + chunk,
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to collect process output",
              cause,
            }),
        ),
      );

    const runClaudeTurn = Effect.fn("evalPartner.runClaudeTurn")(function* (prompt: string) {
      const schemaJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        toJsonSchemaObject(PartnerEvalOutput),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to encode structured output schema.",
              cause,
            }),
        ),
      );
      const claudeEnvironment = yield* makeClaudeEnvironment(claudeConfig, environment);
      const workingDirectory = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-partner-eval-claude-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateHatchTurn",
                detail: "Failed to create Claude eval temp directory",
                cause,
              }),
          ),
        );
      const settingsJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        disableAllHooks: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to encode Claude settings.",
              cause,
            }),
        ),
      );

      const spawnCommand = yield* resolveSpawnCommand(
        claudeConfig.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          schemaJson,
          "--model",
          model,
          ...(effort !== undefined ? (["--effort", effort] as const) : []),
          "--settings",
          settingsJson,
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );

      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to spawn Claude CLI process",
              cause,
            }),
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(child.stdout),
          readStreamAsString(child.stderr),
          child.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateHatchTurn",
                  detail: "Failed to read Claude CLI exit code",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const detail = `${stderr}\n${stdout}`.trim().slice(0, 2000);
        return yield* new TextGenerationError({
          operation: "generateHatchTurn",
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      const decoded = yield* decodeClaudeOutput(stdout).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateHatchTurn",
                detail: "Claude CLI returned unexpected output format.",
                cause,
              }),
            ),
        }),
      );
      const envelope = isClaudeOutputEnvelope(decoded)
        ? decoded
        : decoded.findLast((message) => message.type === "result");
      const structured = envelope?.structured_output;

      return yield* Schema.decodeUnknownEffect(PartnerEvalOutput)(structured).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateHatchTurn",
                detail: "Claude returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

    const runCodexTurn = Effect.fn("evalPartner.runCodexTurn")(function* (prompt: string) {
      const schemaJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        toJsonSchemaObject(PartnerEvalOutput),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to encode structured output schema.",
              cause,
            }),
        ),
      );
      const schemaPath = yield* writeTempFile("schema", schemaJson);
      const outputFile = yield* writeTempFile("output", "");
      const launchArgs = resolveCodexLaunchArgs(codexConfig.launchArgs, environment);

      const spawnCommand = yield* resolveSpawnCommand(
        codexConfig.binaryPath || "codex",
        [
          "exec",
          ...codexExecLaunchArgs(launchArgs),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputFile,
          "-",
        ],
        { env: environment },
      );

      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...environment,
          ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
        },
        cwd: process.cwd(),
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to spawn Codex CLI process",
              cause,
            }),
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(child.stdout),
          readStreamAsString(child.stderr),
          child.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateHatchTurn",
                  detail: "Failed to read Codex CLI exit code",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const combined = `${stderr}\n${stdout}`;
        const errorLines = combined
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(
            (line) =>
              line.startsWith("ERROR:") ||
              line.includes('"detail"') ||
              line.toLowerCase().includes("not supported") ||
              line.toLowerCase().includes("unauthorized") ||
              line.toLowerCase().includes("authentication"),
          );
        const detail = (errorLines.length > 0 ? errorLines.join(" | ") : combined.trim()).slice(
          0,
          2000,
        );
        return yield* new TextGenerationError({
          operation: "generateHatchTurn",
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(PartnerEvalOutput));
      return yield* fs.readFileString(outputFile).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHatchTurn",
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateHatchTurn",
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

    const runScenario = Effect.fn("evalPartner.runScenario")(function* (fixture: PartnerEvalCase) {
      const bot = {
        name: fixture.bot.name ?? "Ada",
        handle: fixture.bot.handle ?? "ada",
        purpose: fixture.bot.purpose ?? "Keeps the repo healthy.",
        instructions: fixture.bot.instructions ?? "Prefer small diffs.",
        tone: fixture.bot.tone ?? 50,
        canDelegate: fixture.bot.canDelegate,
      };
      const capabilities = partnerCapabilitiesForBot(bot);
      const evalRoot = resolveEvalRepoRoot();
      const instructions = buildPartnerSessionInstructions(bot, {
        projectName: "hybrid",
        cwd: evalRoot,
        userLabel: "Lee",
        capabilities,
      });
      const tools = toolsForBot(fixture.bot.canDelegate);
      const messages: PartnerEvalMessage[] = [...fixture.messages];
      const toolsCalled: string[] = [];
      let finalText = "";
      let rounds = 0;
      // Scoping tools often need several rounds before start_developer_task; keep headroom.
      const maxRounds = 5;

      for (let round = 0; round < maxRounds; round++) {
        rounds += 1;
        const prompt = buildEvalPrompt(instructions, tools, messages);
        const output = yield* (
          provider === "claude" ? runClaudeTurn(prompt) : runCodexTurn(prompt)
        ).pipe(Effect.scoped);
        const calls = parseToolCalls(output);
        finalText = output.text.trim();
        for (const call of calls) {
          toolsCalled.push(call.name);
        }
        if (calls.length === 0 || round + 1 >= maxRounds) {
          break;
        }
        // Follow up only when we can return a real tool result (scoping or stub).
        // Otherwise stop — e.g. change-* cases that only call start_developer_task.
        const needsFollowUp = calls.some(
          (call) =>
            EVAL_SCOPING_TOOL_NAMES.has(call.name) || fixture.toolStubs?.[call.name] !== undefined,
        );
        if (!needsFollowUp) {
          break;
        }
        messages.push({
          role: "assistant",
          text:
            finalText.length > 0
              ? finalText
              : `(calling ${calls.map((call) => call.name).join(", ")})`,
        });
        for (const call of calls) {
          if (EVAL_SCOPING_TOOL_NAMES.has(call.name)) {
            messages.push({
              role: "tool",
              toolName: call.name,
              text: executeEvalScopingTool(call.name, call.arguments, evalRoot),
            });
            continue;
          }
          const stub = fixture.toolStubs?.[call.name];
          if (stub === undefined) {
            messages.push({
              role: "tool",
              toolName: call.name,
              text: JSON.stringify({ error: `No stub configured for ${call.name}` }),
            });
            continue;
          }
          messages.push({
            role: "tool",
            toolName: call.name,
            text: JSON.stringify(stub),
          });
        }
      }

      return { text: finalText, toolsCalled, rounds };
    });

    const fixtures =
      onlyIds === null
        ? partnerEvalCases
        : partnerEvalCases.filter((fixture) => onlyIds.has(fixture.id));
    if (fixtures.length === 0) {
      throw new Error("No fixtures matched --only.");
    }

    console.log(
      `Running ${fixtures.length} partner eval scenario(s) with ${provider} model=${model}` +
        (effort !== undefined ? ` effort=${effort}` : "") +
        (strict ? " (strict)" : ""),
    );

    const results: ScenarioResult[] = [];
    for (const fixture of fixtures) {
      process.stdout.write(`→ ${fixture.id} … `);
      const [elapsed, outcome] = yield* runScenario(fixture).pipe(Effect.result, Effect.timed);
      const latencyMs = Duration.toMillis(elapsed);
      if (Result.isFailure(outcome)) {
        const detail = providerErrorDetail(outcome.failure);
        console.log("ERROR");
        results.push({
          id: fixture.id,
          description: fixture.description,
          pass: false,
          latencyMs,
          text: "",
          toolsCalled: [],
          failures: [`provider error: ${detail}`],
          rounds: 0,
        });
        continue;
      }
      const { text, toolsCalled, rounds } = outcome.success;
      const failures = evaluateExpectations(fixture, text, toolsCalled);
      const pass = failures.length === 0;
      console.log(pass ? "ok" : "FAIL");
      results.push({
        id: fixture.id,
        description: fixture.description,
        pass,
        latencyMs,
        text,
        toolsCalled,
        failures,
        rounds,
      });
    }

    printReport(results);

    if (outputPath !== undefined) {
      const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      yield* fs.writeFileString(
        outputPath,
        yield* encodeReport({
          provider,
          model,
          generatedAt: new Date().toISOString(),
          strict,
          results,
        }),
      );
      console.log(`Wrote ${outputPath}`);
    }

    const failedCount = results.filter((result) => !result.pass).length;
    if (strict && failedCount > 0) {
      throw new Error(`${failedCount} scenario(s) failed under --strict.`);
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-partner-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
