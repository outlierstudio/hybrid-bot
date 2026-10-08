import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildReviewPrompt,
  PolicyReviewerError,
  fallbackWhenReviewerFails,
  mergeRuleDecisions,
  parseReviewerIndices,
  reviewRules,
  type ReviewRule,
} from "./reviewRules.ts";

const RULES: ReadonlyArray<ReviewRule> = [
  { index: 0, actionText: "git push is fine", decision: "allow" },
  { index: 1, actionText: "never delete migrations", decision: "never" },
  { index: 2, actionText: "check with me before installing", decision: "ask" },
];

describe("mergeRuleDecisions", () => {
  it("picks never over ask over allow", () => {
    assert.equal(mergeRuleDecisions(["allow", "ask", "never"]), "never");
    assert.equal(mergeRuleDecisions(["allow", "ask"]), "ask");
    assert.equal(mergeRuleDecisions(["allow", "allow"]), "allow");
    assert.equal(mergeRuleDecisions(["never", "allow"]), "never");
    assert.equal(mergeRuleDecisions([]), "allow");
  });
});

describe("fallbackWhenReviewerFails", () => {
  it("keeps none allowed and asks for everything else", () => {
    assert.equal(fallbackWhenReviewerFails("none"), "allow");
    for (const klass of [
      "install",
      "delete",
      "outside-workspace",
      "send",
      "production",
      "secrets",
    ] as const) {
      assert.equal(fallbackWhenReviewerFails(klass), "ask");
    }
  });
});

describe("parseReviewerIndices", () => {
  it("parses plain, fenced, and padded arrays", () => {
    assert.deepEqual(parseReviewerIndices("[0, 2]", 3), [0, 2]);
    assert.deepEqual(parseReviewerIndices("```json\n[2,0,2]\n```", 3), [0, 2]);
    assert.deepEqual(parseReviewerIndices("Applies: [1]", 3), [1]);
    assert.deepEqual(parseReviewerIndices("[]", 3), []);
  });

  it("rejects anything untrustworthy", () => {
    assert.equal(parseReviewerIndices("none apply", 3), null);
    assert.equal(parseReviewerIndices("[0, 5]", 3), null);
    assert.equal(parseReviewerIndices("[-1]", 3), null);
    assert.equal(parseReviewerIndices("[1.5]", 3), null);
    assert.equal(parseReviewerIndices('["0"]', 3), null);
    assert.equal(parseReviewerIndices("[0,", 3), null);
    assert.equal(parseReviewerIndices("{}", 3), null);
  });
});

describe("buildReviewPrompt", () => {
  it("lists the action and indexed rules", () => {
    const prompt = buildReviewPrompt("run git push", RULES);
    assert.include(prompt, "Action: run git push");
    assert.include(prompt, "1: never delete migrations");
    assert.include(prompt, "JSON array");
  });
});

describe("reviewRules", () => {
  it.effect("returns the matched rules from the model's indices", () =>
    Effect.gen(function* () {
      const result = yield* reviewRules("git push", RULES, {
        complete: () => Effect.succeed("[0, 2]"),
      });
      assert.equal(result.status, "reviewed");
      if (result.status === "reviewed") {
        assert.deepEqual(
          result.matched.map((rule) => rule.index),
          [0, 2],
        );
      }
    }),
  );

  it.effect("reports failure for model errors, bad output, or no model", () =>
    Effect.gen(function* () {
      const errored = yield* reviewRules("x", RULES, {
        complete: () => Effect.fail(new PolicyReviewerError({ detail: "boom" })),
      });
      const garbled = yield* reviewRules("x", RULES, { complete: () => Effect.succeed("huh") });
      const missing = yield* reviewRules("x", RULES, undefined);
      assert.equal(errored.status, "failed");
      assert.equal(garbled.status, "failed");
      assert.equal(missing.status, "failed");
    }),
  );

  it.effect("needs no model when there are no rules", () =>
    Effect.gen(function* () {
      const result = yield* reviewRules("x", [], undefined);
      assert.deepEqual(result, { status: "reviewed", matched: [] });
    }),
  );
});
