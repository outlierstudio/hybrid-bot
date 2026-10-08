import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PolicyRulesStore from "./PolicyRulesStore.ts";

const TestLayer = PolicyRulesStore.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("PolicyRulesStore", () => {
  it.effect("adds, lists, and removes rules", () =>
    Effect.gen(function* () {
      const store = yield* PolicyRulesStore.PolicyRulesStore;
      assert.deepEqual(yield* store.list(), []);

      const global = yield* store.add({
        scope: "global",
        scopeId: "ignored",
        actionText: "  Never touch production databases  ",
        decision: "never",
      });
      assert.equal(global.scopeId, null);
      assert.equal(global.actionText, "Never touch production databases");

      const project = yield* store.add({
        scope: "project",
        scopeId: "project-1",
        actionText: "Deleting files under tmp/ is fine",
        decision: "allow",
      });
      assert.deepEqual(
        (yield* store.list()).map((rule) => rule.id).toSorted(),
        [global.id, project.id].toSorted(),
      );

      yield* store.remove(global.id);
      assert.deepEqual(
        (yield* store.list()).map((rule) => rule.id),
        [project.id],
      );
      // Removing again is harmless.
      yield* store.remove(global.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("listApplicable returns global plus matching project and bot rules", () =>
    Effect.gen(function* () {
      const store = yield* PolicyRulesStore.PolicyRulesStore;
      const g = yield* store.add({ scope: "global", actionText: "g", decision: "ask" });
      const p1 = yield* store.add({
        scope: "project",
        scopeId: "p1",
        actionText: "p1",
        decision: "allow",
      });
      yield* store.add({ scope: "project", scopeId: "p2", actionText: "p2", decision: "allow" });
      const b1 = yield* store.add({
        scope: "bot",
        scopeId: "b1",
        actionText: "b1",
        decision: "never",
      });
      yield* store.add({ scope: "bot", scopeId: "b2", actionText: "b2", decision: "never" });

      const ids = (rules: ReadonlyArray<PolicyRulesStore.PolicyRule>) =>
        rules.map((rule) => rule.id).toSorted();

      assert.deepEqual(
        ids(yield* store.listApplicable({ projectId: "p1", botId: "b1" })),
        [g.id, p1.id, b1.id].toSorted(),
      );
      assert.deepEqual(ids(yield* store.listApplicable({})), [g.id]);
      assert.deepEqual(
        ids(yield* store.listApplicable({ projectId: null, botId: "b1" })),
        [g.id, b1.id].toSorted(),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stores structured Always-allow fields with normalized match detail", () =>
    Effect.gen(function* () {
      const store = yield* PolicyRulesStore.PolicyRulesStore;
      const structured = yield* store.add({
        scope: "project",
        scopeId: "p1",
        actionText: "git push origin main (production)",
        decision: "allow",
        approvalClass: "production",
        matchDetail: "  git   push origin main  ",
      });
      assert.equal(structured.approvalClass, "production");
      assert.equal(structured.matchDetail, "git push origin main");
      assert.equal(PolicyRulesStore.isStructuredRule(structured), true);

      const freeText = yield* store.add({
        scope: "global",
        actionText: "never delete migrations",
        decision: "never",
      });
      assert.equal(freeText.approvalClass, null);
      assert.equal(freeText.matchDetail, null);
      assert.equal(PolicyRulesStore.isStructuredRule(freeText), false);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("reads an old whole-line Always-allow rule back as its risky parts", () =>
    Effect.gen(function* () {
      const store = yield* PolicyRulesStore.PolicyRulesStore;
      yield* store.add({
        scope: "project",
        scopeId: "project-1",
        actionText: "old card summary",
        decision: "allow",
        approvalClass: "production",
        matchDetail: `printf 'x' && git add . && git commit -m "first" && git push -u origin master`,
      });
      const single = yield* store.add({
        scope: "project",
        scopeId: "project-1",
        actionText: "Always allow git push origin master",
        decision: "allow",
        approvalClass: "production",
        matchDetail: "git push origin master",
      });
      const listed = yield* store.list();
      const migrated = listed.find((rule) => rule.actionText === "old card summary");
      const kept = listed.find((rule) => rule.id === single.id);
      assert.equal(migrated?.matchDetail, "git push origin master");
      assert.equal(kept?.matchDetail, single.matchDetail);
    }).pipe(Effect.provide(TestLayer)),
  );
});
