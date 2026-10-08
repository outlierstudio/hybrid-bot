/**
 * // HYBRID: PolicyRulesStore — SQLite-backed user approval rules (AUDIT §5.7).
 *
 * Free-text rules need a reviewer. Structured rules (approvalClass + matchDetail)
 * are Always-allow entries for one command part (e.g. `git push origin main`),
 * matched by PolicyEngine with no model. Rows saved as a whole chained line are
 * re-normalized into their parts on read.
 */
import type { ApprovalClass } from "@t3tools/contracts";
import { ApprovalClass as ApprovalClassSchema } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { ruleMatchKeys } from "./classify.ts";

export const PolicyRuleScope = Schema.Literals(["global", "project", "bot"]);
export type PolicyRuleScope = typeof PolicyRuleScope.Type;

export const PolicyRuleDecision = Schema.Literals(["allow", "ask", "never"]);
export type PolicyRuleDecision = typeof PolicyRuleDecision.Type;

export interface PolicyRule {
  readonly id: string;
  readonly scope: PolicyRuleScope;
  /** projectId or botId; null for global rules. */
  readonly scopeId: string | null;
  readonly actionText: string;
  readonly decision: PolicyRuleDecision;
  /** Set with matchDetail for deterministic Always-allow rules. */
  readonly approvalClass: ApprovalClass | null;
  /** Normalized command/path; null means free-text (reviewer) rule. */
  readonly matchDetail: string | null;
  readonly createdAt: string;
}

export interface AddPolicyRuleInput {
  readonly scope: PolicyRuleScope;
  readonly scopeId?: string | null | undefined;
  readonly actionText: string;
  readonly decision: PolicyRuleDecision;
  readonly approvalClass?: ApprovalClass | null | undefined;
  readonly matchDetail?: string | null | undefined;
}

export interface PolicyRuleScopeQuery {
  readonly projectId?: string | null | undefined;
  readonly botId?: string | null | undefined;
}

type PolicyRuleRow = {
  readonly id: string;
  readonly scope: string;
  readonly scope_id: string | null;
  readonly action_text: string;
  readonly decision: string;
  readonly approval_class: string | null;
  readonly match_detail: string | null;
  readonly created_at: string;
};

const decodeScope = Schema.decodeUnknownSync(PolicyRuleScope);
const decodeDecision = Schema.decodeUnknownSync(PolicyRuleDecision);
const decodeApprovalClass = Schema.decodeUnknownSync(ApprovalClassSchema);

/** Collapse whitespace so Always-allow matches ignore trivial formatting. */
export function normalizeMatchDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, " ");
}

/** Old rules stored a whole chained line; read them back as their non-`none` parts. */
function renormalizeMatchDetail(matchDetail: string | null): string | null {
  if (matchDetail === null || matchDetail.length === 0) return matchDetail;
  const keys = ruleMatchKeys(matchDetail);
  if (keys.length === 0 || keys.includes(normalizeMatchDetail(matchDetail))) return matchDetail;
  return keys.join(" && ");
}

export const isStructuredRule = (
  rule: PolicyRule,
): rule is PolicyRule & { readonly approvalClass: ApprovalClass; readonly matchDetail: string } =>
  rule.approvalClass !== null && rule.matchDetail !== null && rule.matchDetail.length > 0;

const rowToRule = (row: PolicyRuleRow): PolicyRule => ({
  id: row.id,
  scope: decodeScope(row.scope),
  scopeId: row.scope_id,
  actionText: row.action_text,
  decision: decodeDecision(row.decision),
  approvalClass:
    row.approval_class !== null && row.approval_class.length > 0
      ? decodeApprovalClass(row.approval_class)
      : null,
  matchDetail: renormalizeMatchDetail(row.match_detail),
  createdAt: row.created_at,
});

export class PolicyRulesStore extends Context.Service<
  PolicyRulesStore,
  {
    /** Every rule, oldest first. */
    readonly list: () => Effect.Effect<ReadonlyArray<PolicyRule>>;
    /** Rules that can apply to this project and bot: all global, plus the matching project and bot ones. */
    readonly listApplicable: (
      query: PolicyRuleScopeQuery,
    ) => Effect.Effect<ReadonlyArray<PolicyRule>>;
    readonly add: (input: AddPolicyRuleInput) => Effect.Effect<PolicyRule>;
    /** Removing a rule that does not exist is a no-op. */
    readonly remove: (id: string) => Effect.Effect<void>;
  }
>()("t3/bots/policy/PolicyRulesStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runSql = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A> => Effect.orDie(effect);

  const list: PolicyRulesStore["Service"]["list"] = () =>
    runSql(sql<PolicyRuleRow>`
      SELECT id, scope, scope_id, action_text, decision, approval_class, match_detail, created_at
      FROM policy_rules
      ORDER BY created_at ASC, id ASC
    `).pipe(Effect.map((rows) => rows.map(rowToRule)));

  const listApplicable: PolicyRulesStore["Service"]["listApplicable"] = (query) =>
    list().pipe(
      Effect.map((rules) =>
        rules.filter(
          (rule) =>
            rule.scope === "global" ||
            (rule.scope === "project" &&
              query.projectId != null &&
              rule.scopeId === query.projectId) ||
            (rule.scope === "bot" && query.botId != null && rule.scopeId === query.botId),
        ),
      ),
    );

  const add: PolicyRulesStore["Service"]["add"] = (input) =>
    Effect.gen(function* () {
      const matchDetail =
        input.matchDetail === undefined || input.matchDetail === null
          ? null
          : normalizeMatchDetail(input.matchDetail);
      const rule: PolicyRule = {
        id: `rule-${NodeCrypto.randomUUID()}`,
        scope: input.scope,
        scopeId: input.scope === "global" ? null : (input.scopeId ?? null),
        actionText: input.actionText.trim(),
        decision: input.decision,
        approvalClass: input.approvalClass ?? null,
        matchDetail: matchDetail !== null && matchDetail.length > 0 ? matchDetail : null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* runSql(sql`
        INSERT INTO policy_rules (
          id, scope, scope_id, action_text, decision, approval_class, match_detail, created_at
        )
        VALUES (
          ${rule.id}, ${rule.scope}, ${rule.scopeId}, ${rule.actionText}, ${rule.decision},
          ${rule.approvalClass}, ${rule.matchDetail}, ${rule.createdAt}
        )
      `);
      return rule;
    });

  const remove: PolicyRulesStore["Service"]["remove"] = (id) =>
    runSql(sql`DELETE FROM policy_rules WHERE id = ${id}`).pipe(Effect.asVoid);

  return { list, listApplicable, add, remove } satisfies PolicyRulesStore["Service"];
});

export const layer = Layer.effect(PolicyRulesStore, make);
