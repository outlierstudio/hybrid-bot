/**
 * // HYBRID: BotRegistry tests
 */
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  BUILTIN_BOT_IDS,
  HYBRID_BOT_ID,
  ProviderDriverKind,
  type BotUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { BUILTIN_BOTS, BUILTIN_SEED_VERSION, SPECIALISTS_ARCHIVED_AT } from "./builtins.ts";
import * as BotRegistry from "./BotRegistry.ts";

// Most of these exercise multi-bot behavior (custom bots, archive, restore).
const TestLayer = BotRegistry.layerWith({ multiBot: true }).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);
const OneBotLayer = BotRegistry.layerWith({ multiBot: false }).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("BotRegistry", () => {
  it.effect("seeds built-ins idempotently", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const first = yield* registry.list();
      assert.equal(first.length, 4);
      assert.ok(first.every((b) => b.builtIn));
      // Re-acquire layer would re-seed; within same registry, list again is stable
      const second = yield* registry.list();
      assert.equal(second.length, 4);
      assert.deepEqual(first.map((b) => b.handle).sort(), [
        "hybrid",
        "planner",
        "research",
        "reviewer",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("upsert create and update", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const created = yield* registry.upsert({
        handle: "docs",
        name: "Docs",
        color: "#aabbcc",
        instructions: "Write docs",
        provider: ProviderDriverKind.make("codex"),
        model: null,
        runtimeMode: "approval-required",
        readOnly: true,
        mcpServers: [],
      });
      assert.equal(created.handle, "docs");
      assert.equal(created.builtIn, false);

      const updated = yield* registry.upsert({
        id: created.id,
        handle: "docs",
        name: "Docs Bot",
        color: "#aabbcc",
        instructions: "Write better docs",
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5",
        runtimeMode: "full-access",
        readOnly: false,
        mcpServers: ["fs"],
      });
      assert.equal(updated.name, "Docs Bot");
      assert.equal(updated.model, "gpt-5");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("duplicate handle fails", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const result = yield* registry
        .upsert({
          handle: "hybrid",
          name: "Clone",
          color: "#112233",
          instructions: "",
          provider: ProviderDriverKind.make("codex"),
          model: null,
          runtimeMode: "full-access",
          readOnly: false,
          mcpServers: [],
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("delete and reset built-in", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const id = BotId.make("builtin-research");
      const deleteExit = yield* registry.delete(id).pipe(Effect.exit);
      assert.equal(deleteExit._tag, "Failure");

      yield* registry.upsert({
        id,
        handle: "research",
        name: "Research (edited)",
        color: "#a78bfa",
        instructions: "edited",
        provider: ProviderDriverKind.make("codex"),
        model: null,
        runtimeMode: "approval-required",
        readOnly: true,
        mcpServers: [],
      });
      const edited = yield* registry.get(id);
      assert.equal(edited.name, "Research (edited)");
      assert.equal(edited.userModified, true);

      const restored = yield* registry.resetBuiltIn(id);
      assert.equal(restored.handle, "research");
      assert.equal(restored.name, "Research");
      assert.equal(restored.builtIn, true);
      assert.equal(restored.userModified, false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("upgrades untouched built-ins when seedVersion increases", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const sql = yield* SqlClient.SqlClient;
      const engineer = BUILTIN_BOTS.find((bot) => bot.id === BUILTIN_BOT_IDS.engineer);
      assert.ok(engineer);
      assert.equal(engineer.seedVersion, BUILTIN_SEED_VERSION);

      yield* sql`
        UPDATE bots SET
          seed_version = 1,
          instructions = ${"legacy harness wording"},
          user_modified = 0,
          updated_at = ${"2026-01-01T00:00:00.000Z"}
        WHERE id = ${engineer.id}
      `;
      const downgraded = yield* registry.get(engineer.id);
      assert.equal(downgraded.seedVersion, 1);
      assert.equal(downgraded.instructions, "legacy harness wording");
      assert.equal(downgraded.userModified, false);

      yield* BotRegistry.syncBuiltInSeeds(sql);

      const upgraded = yield* registry.get(engineer.id);
      assert.equal(upgraded.seedVersion, BUILTIN_SEED_VERSION);
      assert.equal(upgraded.instructions, engineer.instructions);
      assert.equal(upgraded.userModified, false);
      assert.ok(!upgraded.instructions.includes("harness"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("archives custom bots and restores them", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const created = yield* registry.upsert({
        handle: "scout",
        name: "Scout",
        color: "#aabbcc",
        instructions: "look around",
        provider: ProviderDriverKind.make("codex"),
        model: null,
        runtimeMode: "approval-required",
        readOnly: true,
        mcpServers: [],
      });
      assert.equal(created.archivedAt, null);

      const archived = yield* registry.archive(created.id);
      assert.ok(archived.archivedAt !== null);
      const again = yield* registry.archive(created.id);
      assert.equal(again.archivedAt, archived.archivedAt);

      const restored = yield* registry.unarchive(created.id);
      assert.equal(restored.archivedAt, null);

      const builtInExit = yield* registry.archive(BotId.make("builtin-research")).pipe(Effect.exit);
      assert.equal(builtInExit._tag, "Failure");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not mark built-ins userModified when upsert matches the seed", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const engineer = BUILTIN_BOTS.find((bot) => bot.id === BUILTIN_BOT_IDS.engineer);
      assert.ok(engineer);

      const saved = yield* registry.upsert({
        id: engineer.id,
        handle: engineer.handle,
        name: engineer.name,
        color: engineer.color,
        instructions: engineer.instructions,
        provider: engineer.provider,
        model: engineer.model,
        runtimeMode: engineer.runtimeMode,
        readOnly: engineer.readOnly,
        mcpServers: [...engineer.mcpServers],
        purpose: engineer.purpose,
        tone: engineer.tone,
        autonomy: engineer.autonomy,
        canDelegate: engineer.canDelegate,
      });
      assert.equal(saved.userModified, false);
      assert.equal(saved.seedVersion, BUILTIN_SEED_VERSION);

      const edited = yield* registry.upsert({
        id: engineer.id,
        handle: engineer.handle,
        name: engineer.name,
        color: engineer.color,
        instructions: "I edited this in Settings",
        provider: engineer.provider,
        model: engineer.model,
        runtimeMode: engineer.runtimeMode,
        readOnly: engineer.readOnly,
        mcpServers: [...engineer.mcpServers],
        purpose: engineer.purpose,
        tone: engineer.tone,
        autonomy: engineer.autonomy,
        canDelegate: engineer.canDelegate,
      });
      assert.equal(edited.userModified, true);
      assert.equal(edited.instructions, "I edited this in Settings");
    }).pipe(Effect.provide(TestLayer)),
  );
});

const SPECIALISTS = [BUILTIN_BOT_IDS.research, BUILTIN_BOT_IDS.reviewer, BUILTIN_BOT_IDS.planner];

/** Put a built-in back to how a v0.1 install stored it (seed 2). */
const resetToSeedTwo = (sql: SqlClient.SqlClient, id: BotId, userModified: boolean) => sql`
  UPDATE bots SET
    seed_version = 2,
    user_modified = ${userModified ? 1 : 0},
    archived_at = NULL
    ${id === BUILTIN_BOT_IDS.engineer ? sql`, handle = 'engineer', name = 'Engineer', color = '#2dd4bf'` : sql``}
  WHERE id = ${id}
`;

describe("seed 3: Engineer becomes Hybrid", () => {
  it.effect("upgrades an untouched Engineer and archives the specialists", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const sql = yield* SqlClient.SqlClient;
      for (const id of [BUILTIN_BOT_IDS.engineer, ...SPECIALISTS]) {
        yield* resetToSeedTwo(sql, id, false);
      }
      assert.equal((yield* registry.get(HYBRID_BOT_ID)).handle, "engineer");

      yield* BotRegistry.syncBuiltInSeeds(sql);

      const hybrid = yield* registry.get(HYBRID_BOT_ID);
      assert.equal(hybrid.id, BUILTIN_BOT_IDS.engineer, "keeps the Engineer id");
      assert.equal(hybrid.handle, "hybrid");
      assert.equal(hybrid.name, "Hybrid");
      assert.equal(hybrid.color, "#F4F4F1");
      assert.equal(hybrid.purpose, "Your associate for this project.");
      assert.equal(hybrid.autonomy, "small-changes");
      assert.equal(hybrid.canDelegate, true);
      assert.equal(hybrid.seedVersion, 3);
      assert.equal(hybrid.archivedAt, null);
      // The partner prompt carries Hybrid's job; the instructions field is for the user's notes.
      assert.equal(hybrid.instructions, "");
      for (const id of SPECIALISTS) {
        const specialist = yield* registry.get(id);
        assert.equal(specialist.archivedAt, SPECIALISTS_ARCHIVED_AT);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("leaves a user-modified Engineer alone, but still archives an edited specialist", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const sql = yield* SqlClient.SqlClient;
      yield* resetToSeedTwo(sql, BUILTIN_BOT_IDS.engineer, true);
      yield* sql`UPDATE bots SET instructions = 'my own words' WHERE id = ${BUILTIN_BOT_IDS.engineer}`;
      yield* resetToSeedTwo(sql, BUILTIN_BOT_IDS.research, true);

      yield* BotRegistry.syncBuiltInSeeds(sql);

      const engineer = yield* registry.get(BUILTIN_BOT_IDS.engineer);
      assert.equal(engineer.handle, "engineer");
      assert.equal(engineer.name, "Engineer");
      assert.equal(engineer.instructions, "my own words");
      assert.equal(engineer.userModified, true);
      assert.equal(engineer.seedVersion, 2);
      assert.equal(engineer.archivedAt, null);
      assert.equal(
        (yield* registry.get(BUILTIN_BOT_IDS.research)).archivedAt,
        SPECIALISTS_ARCHIVED_AT,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the old handle if a custom bot already took @hybrid", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const sql = yield* SqlClient.SqlClient;
      yield* resetToSeedTwo(sql, BUILTIN_BOT_IDS.engineer, false);
      yield* registry.upsert({ ...customBot, handle: "hybrid" });

      yield* BotRegistry.syncBuiltInSeeds(sql);

      const upgraded = yield* registry.get(HYBRID_BOT_ID);
      assert.equal(upgraded.handle, "engineer");
      assert.equal(upgraded.name, "Hybrid");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a fresh install seeds Hybrid live and the specialists archived", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const live = (yield* registry.list()).filter((bot) => bot.archivedAt === null);
      assert.deepEqual(
        live.map((bot) => bot.handle),
        ["hybrid"],
      );
    }).pipe(Effect.provide(OneBotLayer)),
  );
});

const customBot: BotUpsertInput = {
  handle: "docs",
  name: "Docs",
  color: "#aabbcc",
  instructions: "Write docs",
  provider: ProviderDriverKind.make("codex"),
  model: null,
  runtimeMode: "approval-required",
  readOnly: true,
  mcpServers: [],
};

describe("multi-bot off", () => {
  it.effect("rejects creating a bot and editing anything but Hybrid", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const created = yield* registry.upsert(customBot).pipe(Effect.flip);
      assert.equal(created.code, "invalid");
      assert.include(created.message, "Custom bots are disabled");
      const research = yield* registry
        .upsert({ ...customBot, id: BUILTIN_BOT_IDS.research, handle: "research" })
        .pipe(Effect.flip);
      assert.equal(research.code, "invalid");
      assert.equal((yield* registry.list()).length, 4);
    }).pipe(Effect.provide(OneBotLayer)),
  );

  it.effect("still saves Hybrid's own settings", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const hybrid = yield* registry.get(HYBRID_BOT_ID);
      const saved = yield* registry.upsert({
        id: hybrid.id,
        handle: hybrid.handle,
        name: hybrid.name,
        color: hybrid.color,
        instructions: hybrid.instructions,
        provider: hybrid.provider,
        model: hybrid.model,
        runtimeMode: hybrid.runtimeMode,
        readOnly: hybrid.readOnly,
        mcpServers: [...hybrid.mcpServers],
        autonomy: "ask-first",
        tone: 80,
      });
      assert.equal(saved.autonomy, "ask-first");
      assert.equal(saved.tone, 80);
    }).pipe(Effect.provide(OneBotLayer)),
  );

  it.effect("won't restore an archived specialist", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry.BotRegistry;
      const error = yield* registry.unarchive(BUILTIN_BOT_IDS.research).pipe(Effect.flip);
      assert.equal(error.code, "invalid");
    }).pipe(Effect.provide(OneBotLayer)),
  );
});
