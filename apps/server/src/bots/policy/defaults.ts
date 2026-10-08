/**
 * HYBRID: the default decision for an approval class under a bot's autonomy (AUDIT §5.7).
 * Pure; user rules (reviewRules.ts) layer on top of this in the PolicyEngine.
 */
import type { ApprovalClass, BotAutonomy } from "@t3tools/contracts";

export type PolicyDecision = "allow" | "ask" | "never";

const TABLE: Readonly<Record<ApprovalClass, Readonly<Record<BotAutonomy, PolicyDecision>>>> = {
  none: { "ask-first": "allow", "small-changes": "allow", full: "allow" },
  install: { "ask-first": "ask", "small-changes": "allow", full: "allow" },
  delete: { "ask-first": "ask", "small-changes": "ask", full: "allow" },
  "outside-workspace": { "ask-first": "ask", "small-changes": "ask", full: "ask" },
  send: { "ask-first": "ask", "small-changes": "ask", full: "ask" },
  production: { "ask-first": "ask", "small-changes": "ask", full: "ask" },
  secrets: { "ask-first": "never", "small-changes": "ask", full: "ask" },
  // Inline code can do anything; nobody can tell what it does from the request.
  opaque: { "ask-first": "ask", "small-changes": "ask", full: "ask" },
};

export const defaultDecisionFor = (
  approvalClass: ApprovalClass,
  autonomy: BotAutonomy,
): PolicyDecision => TABLE[approvalClass][autonomy];
