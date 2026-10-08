/**
 * HYBRID: the rule reviewer (AUDIT §5.7).
 *
 * User rules are free text, so a model decides which of them apply to an action. The model
 * only picks rule indices; the decision comes from the matched rules' own decisions
 * (never > ask > allow). If the model is missing, errors, or answers badly, the caller
 * falls back conservatively (`fallbackWhenReviewerFails`).
 */
import type { ApprovalClass } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PolicyDecision } from "./defaults.ts";

export interface ReviewRule {
  readonly index: number;
  readonly actionText: string;
  readonly decision: PolicyDecision;
}

/**
 * One-shot prompt → text on the person's model. Optional: when no model is provided the
 * reviewer is "unavailable" and callers take the conservative fallback.
 */
export class PolicyReviewerError extends Schema.TaggedError<PolicyReviewerError>()(
  "PolicyReviewerError",
  { detail: Schema.String },
) {}

export class PolicyReviewerModel extends Context.Service<
  PolicyReviewerModel,
  { readonly complete: (prompt: string) => Effect.Effect<string, PolicyReviewerError> }
>()("t3/bots/policy/reviewRules/PolicyReviewerModel") {}

export type RuleReviewResult =
  | { readonly status: "reviewed"; readonly matched: ReadonlyArray<ReviewRule> }
  | { readonly status: "failed" };

const STRICTNESS: Readonly<Record<PolicyDecision, number>> = { allow: 0, ask: 1, never: 2 };

/** never > ask > allow. An empty list has no opinion and yields "allow"; callers check for matches first. */
export function mergeRuleDecisions(decisions: ReadonlyArray<PolicyDecision>): PolicyDecision {
  let result: PolicyDecision = "allow";
  for (const decision of decisions) {
    if (STRICTNESS[decision] > STRICTNESS[result]) result = decision;
  }
  return result;
}

/** The stricter of two decisions. */
export const stricterOf = (a: PolicyDecision, b: PolicyDecision): PolicyDecision =>
  mergeRuleDecisions([a, b]);

/**
 * Legacy helper kept for tests. PolicyEngine no longer escalates every non-none
 * class when the reviewer is missing — free-text allow must not tighten unrelated
 * requests. Unchecked free-text "never" still becomes ask in the engine.
 */
export function fallbackWhenReviewerFails(baseClass: ApprovalClass): PolicyDecision {
  return baseClass === "none" ? "allow" : "ask";
}

export function buildReviewPrompt(summary: string, rules: ReadonlyArray<ReviewRule>): string {
  const lines = rules.map((rule) => `${rule.index}: ${rule.actionText}`);
  return [
    "You decide which of the user's rules apply to an action an AI developer wants to take.",
    "A rule applies only if the action is clearly what the rule describes.",
    "",
    `Action: ${summary}`,
    "",
    "Rules:",
    ...lines,
    "",
    "Answer with ONLY a JSON array of the indices of the rules that apply, for example [0,2].",
    "If no rule applies, answer [].",
    "No prose, no code fences.",
  ].join("\n");
}

/** Parses the model's answer to unique, in-range rule indices. Null when it cannot be trusted. */
export function parseReviewerIndices(
  text: string,
  ruleCount: number,
): ReadonlyArray<number> | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<number>();
  for (const value of parsed) {
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
    if (value < 0 || value >= ruleCount) return null;
    seen.add(value);
  }
  return [...seen].toSorted((a, b) => a - b);
}

/** Never fails: any model or parse problem is reported as `failed`. */
export const reviewRules = (
  summary: string,
  rules: ReadonlyArray<ReviewRule>,
  model: PolicyReviewerModel["Service"] | undefined,
): Effect.Effect<RuleReviewResult> => {
  if (rules.length === 0) return Effect.succeed({ status: "reviewed", matched: [] });
  if (model === undefined) return Effect.succeed({ status: "failed" });
  return model.complete(buildReviewPrompt(summary, rules)).pipe(
    Effect.map((text): RuleReviewResult => {
      const indices = parseReviewerIndices(text, rules.length);
      if (indices === null) return { status: "failed" };
      const byIndex = new Map(rules.map((rule) => [rule.index, rule]));
      return {
        status: "reviewed",
        matched: indices.flatMap((index) => {
          const rule = byIndex.get(index);
          return rule === undefined ? [] : [rule];
        }),
      };
    }),
    Effect.orElseSucceed((): RuleReviewResult => ({ status: "failed" })),
  );
};
