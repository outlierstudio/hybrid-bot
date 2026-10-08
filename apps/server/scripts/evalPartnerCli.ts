/** Shared CLI parsing for eval-partner (unit-tested). */

export type EvalPartnerProvider = "codex" | "claude";

export type EvalPartnerCliOptions = {
  readonly provider: EvalPartnerProvider;
  readonly model: string;
  /** Claude CLI --effort; ignored for Codex. */
  readonly effort: string | undefined;
  readonly out: string | undefined;
  readonly only: string | undefined;
  readonly strict: boolean;
};

export function parseEvalPartnerProvider(raw: string | undefined): EvalPartnerProvider {
  const value = (raw ?? "codex").trim().toLowerCase();
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unknown --provider ${JSON.stringify(raw)}. Use codex or claude.`);
}

export function parseEvalPartnerCli(values: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly out?: string | undefined;
  readonly only?: string | undefined;
  readonly strict?: boolean | undefined;
}): EvalPartnerCliOptions {
  const provider = parseEvalPartnerProvider(values.provider);
  const model = values.model?.trim() ?? "";
  if (model.length === 0) {
    throw new Error(
      `Use --model <id> with --provider ${provider}. Optional: --effort low|medium|high --only id1,id2 --out path.json --strict`,
    );
  }
  const effortRaw = values.effort?.trim();
  const effort =
    effortRaw !== undefined && effortRaw.length > 0 ? effortRaw.toLowerCase() : undefined;
  return {
    provider,
    model,
    effort,
    out: values.out,
    only: values.only,
    strict: values.strict === true,
  };
}
