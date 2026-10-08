import { describe, expect, it } from "@effect/vitest";
import type { ApprovalClass, BotAutonomy } from "@t3tools/contracts";

import { defaultDecisionFor, type PolicyDecision } from "./defaults.ts";

const EXPECTED: ReadonlyArray<readonly [ApprovalClass, ...ReadonlyArray<PolicyDecision>]> = [
  // class, ask-first, small-changes, full
  ["none", "allow", "allow", "allow"],
  ["install", "ask", "allow", "allow"],
  ["delete", "ask", "ask", "allow"],
  ["outside-workspace", "ask", "ask", "ask"],
  ["send", "ask", "ask", "ask"],
  ["production", "ask", "ask", "ask"],
  ["secrets", "never", "ask", "ask"],
];
const AUTONOMIES: ReadonlyArray<BotAutonomy> = ["ask-first", "small-changes", "full"];

describe("defaultDecisionFor", () => {
  for (const [approvalClass, ...decisions] of EXPECTED) {
    AUTONOMIES.forEach((autonomy, index) => {
      it(`${approvalClass} × ${autonomy} → ${decisions[index]}`, () => {
        expect(defaultDecisionFor(approvalClass, autonomy)).toBe(decisions[index]);
      });
    });
  }
});

describe("opaque", () => {
  it("asks under every autonomy", () => {
    for (const autonomy of ["ask-first", "small-changes", "full"] as const) {
      expect(defaultDecisionFor("opaque", autonomy)).toBe("ask");
    }
  });
});
