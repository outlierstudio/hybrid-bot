/**
 * HYBRID: PolicyEngine — the one place developer approvals are decided (AUDIT §5.7).
 *
 * classify → class×autonomy default → structured Always-allow match per command part →
 * free-text reviewer (optional). A chained command is allowed by rules only when every
 * non-`none` part is covered. Structured rules never need a model. Free-text rules without a
 * reviewer leave the class default alone, except unchecked "never" rules escalate to ask.
 */
import type { ApprovalClass, BotAutonomy, ProviderRequestKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { approvalParts, classifyApprovalRequest, ruleMatchKeys } from "./classify.ts";
import { defaultDecisionFor, type PolicyDecision } from "./defaults.ts";
import { isStructuredRule, PolicyRulesStore, type PolicyRule } from "./PolicyRulesStore.ts";
import {
  mergeRuleDecisions,
  PolicyReviewerModel,
  reviewRules,
  type ReviewRule,
} from "./reviewRules.ts";

export interface PolicyInput {
  readonly requestKind: ProviderRequestKind | undefined;
  readonly detail: string | undefined;
  readonly workspaceRoot: string;
  readonly autonomy: BotAutonomy;
  readonly projectId?: string | null | undefined;
  readonly botId?: string | null | undefined;
}

/** One structured rule an Always-allow click would store. */
export interface AlwaysAllowEntry {
  readonly approvalClass: ApprovalClass;
  readonly matchDetail: string;
}

export type PolicyOutcome =
  | { readonly outcome: "allow" }
  | { readonly outcome: "never"; readonly reason: string }
  | {
      readonly outcome: "ask";
      readonly approvalClass: ApprovalClass;
      readonly summary: string;
      /** The non-`none` parts, normalized; what Always allow remembers. */
      readonly alwaysAllow: ReadonlyArray<AlwaysAllowEntry>;
    };

const CLASS_LABEL: Readonly<Record<ApprovalClass, string>> = {
  none: "a routine action",
  install: "installing or changing packages",
  delete: "deleting files or data",
  "outside-workspace": "touching files outside the project folder",
  send: "sending something to an outside service",
  production: "a production or publishing action",
  secrets: "reading or changing secrets (credentials, keys, or .env files)",
  opaque: "running inline code that can't be checked ahead of time",
};

/**
 * TODO: wire PolicyReviewerModel to TextGeneration only behind an off-by-default
 * server setting. Do not provide the model in server.ts until that exists — every
 * free-text rule check would burn provider usage. Tests may inject a fake model.
 */
export const POLICY_FREE_TEXT_REVIEWER_ENABLED = false;

/** What the user is shown and what the reviewer reads. */
export function summarizeApprovalRequest(input: {
  readonly requestKind: ProviderRequestKind | undefined;
  readonly detail: string | undefined;
  readonly approvalClass: ApprovalClass;
}): string {
  const what = input.detail?.trim() || input.requestKind || "an action";
  return `${what} (${CLASS_LABEL[input.approvalClass]})`;
}

/** Pure mapping from a settled decision to the outcome the supervisor acts on. */
export function toPolicyOutcome(input: {
  readonly decision: PolicyDecision;
  readonly approvalClass: ApprovalClass;
  readonly summary: string;
  readonly neverReason: string;
  readonly alwaysAllow?: ReadonlyArray<AlwaysAllowEntry>;
}): PolicyOutcome {
  switch (input.decision) {
    case "allow":
      return { outcome: "allow" };
    case "never":
      return { outcome: "never", reason: input.neverReason };
    case "ask":
      return {
        outcome: "ask",
        approvalClass: input.approvalClass,
        summary: input.summary,
        alwaysAllow: input.alwaysAllow ?? [],
      };
  }
}

/**
 * For each non-`none` part, the structured rules whose keys cover it. Stored rules are
 * re-normalized on read, so old whole-line rules match their parts.
 */
export function matchStructuredRules(
  rules: ReadonlyArray<PolicyRule>,
  parts: ReadonlyArray<AlwaysAllowEntry>,
): ReadonlyArray<ReadonlyArray<PolicyRule>> {
  const structured = rules
    .filter(isStructuredRule)
    .map((rule) => ({ rule, keys: new Set(ruleMatchKeys(rule.matchDetail)) }));
  return parts.map((part) =>
    structured.filter((entry) => entry.keys.has(part.matchDetail)).map((entry) => entry.rule),
  );
}

export class PolicyEngine extends Context.Service<
  PolicyEngine,
  { readonly decide: (input: PolicyInput) => Effect.Effect<PolicyOutcome> }
>()("t3/bots/policy/PolicyEngine") {}

const make = Effect.gen(function* () {
  const rulesStore = yield* PolicyRulesStore;
  const reviewer = yield* Effect.serviceOption(PolicyReviewerModel);

  const decide: PolicyEngine["Service"]["decide"] = Effect.fn("PolicyEngine.decide")(
    function* (input) {
      const approvalClass = classifyApprovalRequest({
        requestKind: input.requestKind,
        detail: input.detail,
        workspaceRoot: input.workspaceRoot,
      });
      const summary = summarizeApprovalRequest({
        requestKind: input.requestKind,
        detail: input.detail,
        approvalClass,
      });
      const base = defaultDecisionFor(approvalClass, input.autonomy);
      const alwaysAllow: ReadonlyArray<AlwaysAllowEntry> = approvalParts({
        requestKind: input.requestKind,
        detail: input.detail,
        workspaceRoot: input.workspaceRoot,
      })
        .filter((part) => part.approvalClass !== "none" && part.key.length > 0)
        .map((part) => ({ approvalClass: part.approvalClass, matchDetail: part.key }));
      const classReason = `Not allowed: this is ${CLASS_LABEL[approvalClass]}, which this bot may not do on its own.`;

      const applicable = yield* rulesStore.listApplicable({
        projectId: input.projectId,
        botId: input.botId,
      });
      if (applicable.length === 0) {
        return toPolicyOutcome({
          decision: base,
          approvalClass,
          summary,
          neverReason: classReason,
          alwaysAllow,
        });
      }

      const partHits = matchStructuredRules(applicable, alwaysAllow);
      if (partHits.some((hits) => hits.length > 0)) {
        // Each part is decided on its own: its class default, then its rules. Allow may
        // override ask, but class×autonomy "never" (e.g. secrets + ask-first) stays.
        const partDecisions = alwaysAllow.map((part, index) => {
          const partBase = defaultDecisionFor(part.approvalClass, input.autonomy);
          const hits = partHits[index]!;
          if (hits.length === 0) return partBase;
          const fromRules = mergeRuleDecisions(hits.map((rule) => rule.decision));
          return fromRules === "never" || partBase === "never" ? "never" : fromRules;
        });
        const decision = mergeRuleDecisions([
          ...partDecisions,
          base === "never" ? "never" : "allow",
        ]);
        const blocking = partHits.flat().filter((rule) => rule.decision === "never");
        const neverReason =
          blocking.length > 0
            ? `Not allowed by the user's rule: ${[...new Set(blocking.map((rule) => rule.actionText))].join("; ")}`
            : classReason;
        return toPolicyOutcome({ decision, approvalClass, summary, neverReason, alwaysAllow });
      }

      const freeText = applicable.filter((rule) => !isStructuredRule(rule));
      if (freeText.length === 0) {
        return toPolicyOutcome({
          decision: base,
          approvalClass,
          summary,
          neverReason: classReason,
          alwaysAllow,
        });
      }

      // Only present when a Layer provides PolicyReviewerModel (tests today; never
      // from server.ts while POLICY_FREE_TEXT_REVIEWER_ENABLED is false).
      const model = Option.getOrUndefined(reviewer);

      if (model === undefined) {
        // No reviewer: ignore free-text allow/ask so one Always-allow cannot tighten
        // unrelated requests. Unchecked free-text "never" still escalates to ask.
        const hasUncheckedNever = freeText.some((rule) => rule.decision === "never");
        return toPolicyOutcome({
          decision: hasUncheckedNever && base !== "never" ? "ask" : base,
          approvalClass,
          summary,
          neverReason: classReason,
          alwaysAllow,
        });
      }

      const reviewable: ReadonlyArray<ReviewRule> = freeText.map((rule, index) => ({
        index,
        actionText: rule.actionText,
        decision: rule.decision,
      }));
      const review = yield* reviewRules(summary, reviewable, model);

      if (review.status === "failed") {
        const hasUncheckedNever = freeText.some((rule) => rule.decision === "never");
        return toPolicyOutcome({
          decision: hasUncheckedNever && base !== "never" ? "ask" : base,
          approvalClass,
          summary,
          neverReason: classReason,
          alwaysAllow,
        });
      }
      if (review.matched.length === 0) {
        return toPolicyOutcome({
          decision: base,
          approvalClass,
          summary,
          neverReason: classReason,
          alwaysAllow,
        });
      }

      const fromRules = mergeRuleDecisions(review.matched.map((rule) => rule.decision));
      const decision = fromRules === "never" ? "never" : base === "never" ? "never" : fromRules;
      const blocking = review.matched.filter((rule) => rule.decision === "never");
      const neverReason =
        blocking.length > 0
          ? `Not allowed by the user's rule: ${blocking.map((rule) => rule.actionText).join("; ")}`
          : classReason;
      return toPolicyOutcome({ decision, approvalClass, summary, neverReason, alwaysAllow });
    },
  );

  return { decide } satisfies PolicyEngine["Service"];
});

/** Needs PolicyRulesStore. PolicyReviewerModel is optional and off by default. */
export const layer = Layer.effect(PolicyEngine, make);
