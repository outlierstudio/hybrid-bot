/**
 * // HYBRID: PolicyRulesStore wire types (AUDIT §5.7 / Phase 7 settings UI).
 *
 * Rules are created from decision cards ("Always allow"). Settings lists them
 * and lets the person remove ones they no longer want.
 */
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ApprovalClass } from "./developerTask.ts";

export const PolicyRuleScope = Schema.Literals(["global", "project", "bot"]);
export type PolicyRuleScope = typeof PolicyRuleScope.Type;

export const PolicyRuleDecision = Schema.Literals(["allow", "ask", "never"]);
export type PolicyRuleDecision = typeof PolicyRuleDecision.Type;

export const PolicyRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  scope: PolicyRuleScope,
  scopeId: Schema.NullOr(Schema.String),
  actionText: Schema.String,
  decision: PolicyRuleDecision,
  approvalClass: Schema.NullOr(ApprovalClass),
  matchDetail: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type PolicyRule = typeof PolicyRule.Type;

export const PolicyRulesListResult = Schema.Struct({
  rules: Schema.Array(PolicyRule),
});
export type PolicyRulesListResult = typeof PolicyRulesListResult.Type;

export const PolicyRuleRemoveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type PolicyRuleRemoveInput = typeof PolicyRuleRemoveInput.Type;

export const PolicyRuleError = Schema.Struct({
  code: Schema.Literals(["not-found", "invalid"]),
  message: TrimmedNonEmptyString,
});
export type PolicyRuleError = typeof PolicyRuleError.Type;
