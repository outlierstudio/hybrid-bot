/**
 * HYBRID: migrations 057-059.
 *
 * Primary path builds a DB through migration 056, seeds representative rows,
 * then applies 057-059 and asserts schema + preserved data. An optional extra
 * copies ~/.hybrid/dev/state.sqlite when present.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const NOW = "2026-01-01T00:00:00.000Z";
const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.4"}';

const assertPartnerSchema = Effect.fn("assertPartnerSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_developer_tasks'
  `;
  assert.isTrue(tables.some((row) => row.name === "projection_developer_tasks"));

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  for (const name of ["kind", "parent_thread_id", "partner_bot_id"]) {
    assert.isTrue(
      threadColumns.some((column) => column.name === name),
      `projection_threads.${name}`,
    );
  }

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  assert.isTrue(
    projectColumns.some((column) => column.name === "default_partner_bot_id"),
    "projection_projects.default_partner_bot_id",
  );

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  for (const name of ["origin", "visibility", "developer_task_id"]) {
    assert.isTrue(
      messageColumns.some((column) => column.name === name),
      `projection_thread_messages.${name}`,
    );
  }

  const botColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(bots)
  `;
  for (const name of [
    "purpose",
    "tone",
    "autonomy",
    "can_delegate",
    "partner_engine_json",
    "developer_engine_json",
    "seed_version",
    "user_modified",
    "archived_at",
    "instructions",
    "runtime_mode",
    "read_only",
    "mcp_servers_json",
  ]) {
    assert.isTrue(
      botColumns.some((column) => column.name === name),
      `bots.${name}`,
    );
  }
});

const seedPreHybridRows = Effect.fn("seedPreHybridRows")(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      'project-1', 'Seed Project', '/tmp/seed', '[]', ${NOW}, ${NOW}, NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, created_at, updated_at
    ) VALUES (
      'thread-1', 'project-1', 'Seed Thread', ${MODEL_SELECTION}, ${NOW}, ${NOW}
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
      bot_id, bot_snapshot_json
    ) VALUES (
      'message-1', 'thread-1', NULL, 'assistant', 'hello from engineer', 0, ${NOW}, ${NOW},
      'builtin-engineer',
      '{"handle":"engineer","name":"Engineer","color":"#2dd4bf"}'
    )
  `;

  yield* sql`
    INSERT INTO bots (
      id, handle, name, color, instructions, provider, model,
      runtime_mode, read_only, mcp_servers_json, built_in,
      created_at, updated_at
    ) VALUES (
      'builtin-engineer', 'engineer', 'Engineer', '#2dd4bf',
      'You are Engineer.', 'codex', 'gpt-5.4',
      'full-access', 0, '[]', 1,
      ${NOW}, ${NOW}
    )
  `;
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "057-059 hybrid partner migrations (synthetic)",
  (it) => {
    it.effect("preserves seeded rows through 057-059", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* seedPreHybridRows();

        const beforeMessages = yield* sql<{
          readonly message_id: string;
          readonly bot_id: string | null;
          readonly text: string;
        }>`
        SELECT message_id, bot_id, text FROM projection_thread_messages
      `;
        assert.strictEqual(beforeMessages.length, 1);
        assert.strictEqual(beforeMessages[0]?.bot_id, "builtin-engineer");

        yield* runMigrations();
        yield* assertPartnerSchema();

        const projects = yield* sql<{
          readonly project_id: string;
          readonly default_partner_bot_id: string | null;
        }>`
        SELECT project_id, default_partner_bot_id FROM projection_projects
      `;
        assert.strictEqual(projects[0]?.project_id, "project-1");
        assert.strictEqual(projects[0]?.default_partner_bot_id, null);

        const threads = yield* sql<{
          readonly thread_id: string;
          readonly kind: string;
          readonly partner_bot_id: string | null;
        }>`
        SELECT thread_id, kind, partner_bot_id FROM projection_threads
      `;
        assert.strictEqual(threads[0]?.thread_id, "thread-1");
        assert.strictEqual(threads[0]?.kind, "chat");
        assert.strictEqual(threads[0]?.partner_bot_id, null);

        const messages = yield* sql<{
          readonly message_id: string;
          readonly bot_id: string | null;
          readonly bot_snapshot_json: string | null;
          readonly origin: string | null;
          readonly text: string;
        }>`
        SELECT message_id, bot_id, bot_snapshot_json, origin, text
        FROM projection_thread_messages
      `;
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0]?.bot_id, "builtin-engineer");
        assert.strictEqual(messages[0]?.text, "hello from engineer");
        assert.isTrue(messages[0]?.bot_snapshot_json?.includes("engineer") ?? false);
        assert.strictEqual(messages[0]?.origin, null);

        const bots = yield* sql<{
          readonly id: string;
          readonly instructions: string;
          readonly purpose: string;
          readonly autonomy: string;
        }>`
        SELECT id, instructions, purpose, autonomy FROM bots WHERE id = 'builtin-engineer'
      `;
        assert.strictEqual(bots.length, 1);
        assert.strictEqual(bots[0]?.instructions, "You are Engineer.");
        assert.strictEqual(bots[0]?.purpose, "");
        assert.strictEqual(bots[0]?.autonomy, "small-changes");
      }),
    );
  },
);

const realDbPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  return path.join(home, ".hybrid", "dev", "state.sqlite");
});

const copyDatabase = (sourcePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: "hybrid-mig-" });
    const target = path.join(directory, "state.sqlite");
    yield* fs.copyFile(sourcePath, target);
    for (const suffix of ["-wal", "-shm"] as const) {
      const side = `${sourcePath}${suffix}`;
      if (yield* fs.exists(side)) {
        yield* fs.copyFile(side, `${target}${suffix}`);
      }
    }
    return target;
  });

it.layer(NodeServices.layer)("057-059 hybrid partner migrations (optional real DB)", (it) => {
  it.effect("adds schema on a copy of ~/.hybrid/dev/state.sqlite when present", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourcePath = yield* realDbPath;
      if (sourcePath === null || !(yield* fs.exists(sourcePath))) {
        return;
      }

      const copiedPath = yield* copyDatabase(sourcePath);
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* assertPartnerSchema();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: copiedPath })));
    }),
  );
});
