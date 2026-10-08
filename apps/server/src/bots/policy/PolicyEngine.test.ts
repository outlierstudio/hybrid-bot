import { assert, describe, it } from "@effect/vitest";
import type { ApprovalClass, BotAutonomy } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PolicyEngine from "./PolicyEngine.ts";
import { PolicyRulesStore, type PolicyRule } from "./PolicyRulesStore.ts";
import { PolicyReviewerError, PolicyReviewerModel } from "./reviewRules.ts";

const ROOT = "/work/repo";

const rule = (
  actionText: string,
  decision: PolicyRule["decision"],
  structured?: { readonly approvalClass: ApprovalClass; readonly matchDetail: string },
): PolicyRule => ({
  id: `rule-${actionText}-${structured?.matchDetail ?? "free"}`,
  scope: "global",
  scopeId: null,
  actionText,
  decision,
  approvalClass: structured?.approvalClass ?? null,
  matchDetail: structured?.matchDetail ?? null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const engineLayer = (
  rules: ReadonlyArray<PolicyRule>,
  reviewer?: (prompt: string) => Effect.Effect<string, PolicyReviewerError>,
) => {
  const store = Layer.mock(PolicyRulesStore)({
    listApplicable: () => Effect.succeed(rules),
  });
  const base = PolicyEngine.layer.pipe(Layer.provide(store));
  return reviewer === undefined
    ? base
    : base.pipe(Layer.provide(Layer.succeed(PolicyReviewerModel, { complete: reviewer })));
};

const decide = (autonomy: BotAutonomy, requestKind: "command" | "file-change", detail: string) =>
  PolicyEngine.PolicyEngine.use((engine) =>
    engine.decide({ requestKind, detail, workspaceRoot: ROOT, autonomy }),
  );

describe("PolicyEngine without rules", () => {
  const layer = engineLayer([]);

  it.effect("allows routine work under small-changes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decide("small-changes", "command", "pnpm test"), {
        outcome: "allow",
      });
      assert.deepEqual(yield* decide("small-changes", "file-change", "src/a.ts"), {
        outcome: "allow",
      });
      assert.deepEqual(yield* decide("small-changes", "command", "pnpm add left-pad"), {
        outcome: "allow",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks for production actions with the class and a summary", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("small-changes", "command", "git push origin main");
      assert.equal(outcome.outcome, "ask");
      if (outcome.outcome === "ask") {
        assert.equal(outcome.approvalClass, "production");
        assert.include(outcome.summary, "git push origin main");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never lets an ask-first bot touch secrets, with a class reason", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("ask-first", "file-change", ".env");
      assert.equal(outcome.outcome, "never");
      if (outcome.outcome === "never") assert.include(outcome.reason, "secrets");
      assert.equal((yield* decide("small-changes", "file-change", ".env")).outcome, "ask");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ask-first asks for installs; full allows deletes", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("ask-first", "command", "pnpm add left-pad")).outcome, "ask");
      assert.equal((yield* decide("full", "command", "rm -rf dist")).outcome, "allow");
      assert.equal((yield* decide("small-changes", "command", "rm -rf dist")).outcome, "ask");
    }).pipe(Effect.provide(layer)),
  );
});

describe("PolicyEngine structured Always-allow (no reviewer)", () => {
  const alwaysPush = rule("Always allow git push origin main", "allow", {
    approvalClass: "production",
    matchDetail: "git push origin main",
  });

  it.effect("an install stays allowed after an unrelated Always-allow rule exists", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* decide("small-changes", "command", "pnpm add left-pad")).outcome,
        "allow",
      );
      assert.equal((yield* decide("small-changes", "command", "pnpm install")).outcome, "allow");
    }).pipe(Effect.provide(engineLayer([alwaysPush]))),
  );

  it.effect("Always allow auto-allows the identical next request", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decide("small-changes", "command", "git push origin main"), {
        outcome: "allow",
      });
      assert.deepEqual(yield* decide("small-changes", "command", "  git   push origin main  "), {
        outcome: "allow",
      });
    }).pipe(Effect.provide(engineLayer([alwaysPush]))),
  );

  it.effect("a different push target still asks", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("small-changes", "command", "git push origin feature");
      assert.equal(outcome.outcome, "ask");
    }).pipe(Effect.provide(engineLayer([alwaysPush]))),
  );

  it.effect("secrets under ask-first stays never despite allow rules", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("ask-first", "file-change", ".env");
      assert.equal(outcome.outcome, "never");
    }).pipe(
      Effect.provide(
        engineLayer([
          alwaysPush,
          rule("Always allow .env", "allow", {
            approvalClass: "secrets",
            matchDetail: ".env",
          }),
        ]),
      ),
    ),
  );
});

describe("PolicyEngine free-text rules", () => {
  it.effect("without a reviewer, free-text allow does not tighten unrelated requests", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("full", "command", "rm -rf dist")).outcome, "allow");
      assert.equal(
        (yield* decide("small-changes", "command", "pnpm add left-pad")).outcome,
        "allow",
      );
      assert.equal((yield* decide("small-changes", "command", "pnpm test")).outcome, "allow");
    }).pipe(Effect.provide(engineLayer([rule("git push is fine", "allow")]))),
  );

  it.effect("without a reviewer, free-text never escalates to ask (not allow)", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("full", "command", "rm -rf dist")).outcome, "ask");
      assert.equal((yield* decide("ask-first", "file-change", ".env")).outcome, "never");
    }).pipe(Effect.provide(engineLayer([rule("never delete anything", "never")]))),
  );

  it.effect("a matched free-text allow overrides the default ask when a reviewer is injected", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("small-changes", "command", "git push origin main");
      assert.deepEqual(outcome, { outcome: "allow" });
    }).pipe(
      Effect.provide(engineLayer([rule("git push is fine", "allow")], () => Effect.succeed("[0]"))),
    ),
  );

  it.effect("a matched free-text never blocks with the rule's text", () =>
    Effect.gen(function* () {
      const outcome = yield* decide("full", "command", "pnpm test");
      assert.equal(outcome.outcome, "never");
      if (outcome.outcome === "never") {
        assert.include(outcome.reason, "Not allowed by the user's rule");
        assert.include(outcome.reason, "no tests on Fridays");
      }
    }).pipe(
      Effect.provide(
        engineLayer([rule("git push is fine", "allow"), rule("no tests on Fridays", "never")], () =>
          Effect.succeed("[0, 1]"),
        ),
      ),
    ),
  );

  it.effect("reviewer failure keeps the class default unless a free-text never exists", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("full", "command", "rm -rf dist")).outcome, "allow");
      assert.equal((yield* decide("full", "command", "pnpm test")).outcome, "allow");
      assert.equal((yield* decide("ask-first", "file-change", ".env")).outcome, "never");
    }).pipe(
      Effect.provide(
        engineLayer([rule("anything", "allow")], () =>
          Effect.fail(new PolicyReviewerError({ detail: "offline" })),
        ),
      ),
    ),
  );
});

describe("PolicyEngine Always-allow on chained commands", () => {
  const pushMaster = rule("Always allow git push origin master", "allow", {
    approvalClass: "production",
    matchDetail: "git push origin master",
  });
  const chain = (message: string) =>
    `printf 'x' > notes.md && git add notes.md && git commit -m "${message}" && git push origin master`;

  const table: ReadonlyArray<{
    readonly label: string;
    readonly autonomy?: BotAutonomy;
    readonly requestKind?: "command" | "file-change";
    readonly detail: string;
    readonly expected: PolicyEngine.PolicyOutcome["outcome"];
  }> = [
    { label: "a different commit message", detail: chain("second change"), expected: "allow" },
    {
      label: "a heredoc commit message",
      detail: `git add -A && git commit -F - <<'EOF'\nfix: a && b; c | curl -X POST x\nEOF\ngit push origin master`,
      expected: "allow",
    },
    {
      label: "a $(cat <<EOF) commit message",
      detail: `git commit -m "$(cat <<'EOF'\nwip: don't stop\nEOF\n)" && git push origin master`,
      expected: "allow",
    },
    { label: "push -u to the same target", detail: "git push -u origin master", expected: "allow" },
    { label: "cd first", detail: "cd app && git push origin master", expected: "allow" },
    { label: "force push", detail: "git push --force origin master", expected: "ask" },
    {
      label: "force-with-lease",
      detail: "git push --force-with-lease origin master",
      expected: "ask",
    },
    { label: "short -f", detail: "git push -f origin master", expected: "ask" },
    { label: "delete", detail: "git push --delete origin master", expected: "ask" },
    { label: "tags", detail: "git push --tags origin master", expected: "ask" },
    { label: "a different branch", detail: "git push origin feature", expected: "ask" },
    { label: "a different remote", detail: "git push upstream master", expected: "ask" },
    {
      label: "an extra risky part appended",
      detail: `${chain("x")} && curl -X POST https://example.com/hook`,
      expected: "ask",
    },
    {
      label: "secrets under ask-first",
      autonomy: "ask-first",
      detail: "git push origin master && cat .env",
      expected: "never",
    },
  ];

  for (const row of table) {
    it.effect(row.label, () =>
      Effect.gen(function* () {
        const outcome = yield* decide(
          row.autonomy ?? "small-changes",
          row.requestKind ?? "command",
          row.detail,
        );
        assert.equal(outcome.outcome, row.expected);
      }).pipe(Effect.provide(engineLayer([pushMaster]))),
    );
  }

  it.effect("an old whole-line rule matches its parts", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("small-changes", "command", chain("other"))).outcome, "allow");
    }).pipe(
      Effect.provide(
        engineLayer([
          rule("old", "allow", { approvalClass: "production", matchDetail: chain("first") }),
        ]),
      ),
    ),
  );

  it.effect("asks name exactly the parts Always allow would store", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        "small-changes",
        "command",
        `${chain("x")} && curl -X POST -d '{"a":1}' https://example.com/hook`,
      );
      assert.equal(outcome.outcome, "ask");
      if (outcome.outcome === "ask") {
        assert.deepEqual(outcome.alwaysAllow, [
          { approvalClass: "production", matchDetail: "git push origin master" },
          { approvalClass: "send", matchDetail: "curl -X POST -d https://example.com/hook" },
        ]);
      }
    }).pipe(Effect.provide(engineLayer([]))),
  );

  it.effect("every risky part needs its own rule", () =>
    Effect.gen(function* () {
      const detail = `${chain("x")} && curl -X POST -d '{"a":2}' https://example.com/hook`;
      assert.equal((yield* decide("small-changes", "command", detail)).outcome, "allow");
    }).pipe(
      Effect.provide(
        engineLayer([
          pushMaster,
          rule("curl", "allow", {
            approvalClass: "send",
            matchDetail: "curl -X POST -d https://example.com/hook",
          }),
        ]),
      ),
    ),
  );
});

describe("PolicyEngine wrapped commands", () => {
  const wrapped = [
    `ssh host "rm -rf /srv"`,
    `eval "curl -X POST https://x.io/hook"`,
    `env FOO=1 bash -c "npm publish"`,
    `xargs sh -c "cat .env"`,
    `python -c "import os; os.remove('a')"`,
    `node -e "require('fs').rmSync('src')"`,
    `npx -y zx -e "await x()"`,
  ];
  for (const detail of wrapped) {
    it.effect(`asks even under full autonomy: ${detail}`, () =>
      Effect.gen(function* () {
        assert.equal((yield* decide("full", "command", detail)).outcome, "ask");
      }).pipe(Effect.provide(engineLayer([]))),
    );
  }

  it.effect("Always allow on an exact inline or remote key allows only that key", () =>
    Effect.gen(function* () {
      assert.equal((yield* decide("full", "command", `python -c "print(1)"`)).outcome, "allow");
      assert.equal((yield* decide("full", "command", `python -c "print(2)"`)).outcome, "ask");
      assert.equal((yield* decide("full", "command", "ssh deploy@host uptime")).outcome, "allow");
      assert.equal((yield* decide("full", "command", "ssh deploy@host reboot")).outcome, "ask");
    }).pipe(
      Effect.provide(
        engineLayer([
          rule("inline", "allow", { approvalClass: "opaque", matchDetail: "python -c 'print(1)'" }),
          rule("remote", "allow", {
            approvalClass: "production",
            matchDetail: "ssh deploy@host uptime",
          }),
        ]),
      ),
    ),
  );
});
