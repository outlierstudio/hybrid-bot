import { assert, it } from "@effect/vitest";
import { BotSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(BotSnapshot));

const snapshot = (handle: string, name: string, color: string) =>
  JSON.stringify({ handle, name, color });

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("063_ProjectionThreadBots", (it) => {
  it.effect("backfills one row per thread and bot, matching the old message scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });

      const insert = (
        id: string,
        threadId: string,
        createdAt: string,
        botId: string | null,
        botSnapshot: string | null,
      ) => sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
          bot_id, bot_snapshot_json
        ) VALUES (
          ${id}, ${threadId}, NULL, 'assistant', ${id}, 0, ${createdAt}, ${createdAt},
          ${botId}, ${botSnapshot}
        )
      `;
      const eng = snapshot("engineer", "Engineer", "#3366ff");
      yield* insert("a1", "t1", "2026-01-01T00:03:00Z", "bot-eng", eng);
      yield* insert("a0", "t1", "2026-01-01T00:01:00Z", null, null);
      yield* insert(
        "a2",
        "t1",
        "2026-01-01T00:02:00Z",
        "bot-res",
        snapshot("research", "Research", "#22aa55"),
      );
      yield* insert(
        "a3",
        "t1",
        "2026-01-01T00:04:00Z",
        "bot-eng",
        snapshot("engineer", "Renamed", "#3366ff"),
      );
      yield* insert("b1", "t2", "2026-01-01T00:05:00Z", "bot-eng", eng);
      yield* insert("bad", "t2", "2026-01-01T00:06:00Z", "bot-x", "not json");

      // The pre-063 read: every message with a snapshot, first per handle wins.
      const legacy = new Map<string, Array<{ handle: string; name: string; color: string }>>();
      for (const row of yield* sql<{ threadId: string; botSnapshot: string }>`
        SELECT thread_id AS "threadId", bot_snapshot_json AS "botSnapshot"
        FROM projection_thread_messages WHERE bot_snapshot_json IS NOT NULL
        ORDER BY created_at ASC
      `) {
        const parsed = decodeSnapshot(row.botSnapshot);
        if (Option.isNone(parsed)) continue;
        const decoded = parsed.value;
        const list = legacy.get(row.threadId) ?? [];
        if (!list.some((bot) => bot.handle === decoded.handle)) list.push(decoded);
        legacy.set(row.threadId, list);
      }

      yield* runMigrations();

      const rows = yield* sql<{
        threadId: string;
        botId: string;
        handle: string;
        name: string;
        color: string;
        firstUsedAt: string;
      }>`
        SELECT thread_id AS "threadId", bot_id AS "botId", handle, name, color,
          first_used_at AS "firstUsedAt"
        FROM projection_thread_bots ORDER BY thread_id, first_used_at
      `;
      assert.deepEqual(
        rows.map((row) => [row.threadId, row.botId, row.name, row.firstUsedAt]),
        [
          ["t1", "bot-res", "Research", "2026-01-01T00:02:00Z"],
          ["t1", "bot-eng", "Engineer", "2026-01-01T00:03:00Z"],
          ["t2", "bot-eng", "Engineer", "2026-01-01T00:05:00Z"],
        ],
      );
      const fromTable = new Map<string, Array<{ handle: string; name: string; color: string }>>();
      for (const row of rows) {
        const list = fromTable.get(row.threadId) ?? [];
        list.push({ handle: row.handle, name: row.name, color: row.color });
        fromTable.set(row.threadId, list);
      }
      assert.deepEqual(fromTable, legacy);
    }),
  );
});
