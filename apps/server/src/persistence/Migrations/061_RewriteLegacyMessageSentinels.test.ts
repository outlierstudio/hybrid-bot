import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const NOW = "2026-01-01T00:00:00.000Z";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "061_RewriteLegacyMessageSentinels",
  (it) => {
    it.effect("rewrites sentinel rows to typed fields once and leaves others alone", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });

        const insert = (
          id: string,
          role: string,
          text: string,
          botId: string | null,
          origin: string | null = null,
        ) => sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
            bot_id, origin
          ) VALUES (
            ${id}, 'thread-1', NULL, ${role}, ${text}, 0, ${NOW}, ${NOW}, ${botId}, ${origin}
          )
        `;

        yield* insert("brief", "user", '[[hybrid:harness-brief]]\n{"goal":"x"}', "bot-1");
        yield* insert("voice", "assistant", "[[hybrid:partner]]\n  Created the file.  ", "bot-1");
        yield* insert("voice-inline", "assistant", "[[hybrid:partner]]Done.", null);
        yield* insert("plain", "assistant", "hello", "bot-1");
        yield* insert("mention", "user", "see [[hybrid:partner]] in docs", null);
        yield* insert("wake", "user", "wake up", null, "system-wake");

        yield* runMigrations();

        const rows = yield* sql<{
          readonly message_id: string;
          readonly text: string;
          readonly origin: string | null;
          readonly visibility: string | null;
          readonly bot_id: string | null;
        }>`
          SELECT message_id, text, origin, visibility, bot_id
          FROM projection_thread_messages ORDER BY message_id
        `;
        const byId = new Map(rows.map((row) => [row.message_id, row]));

        const brief = byId.get("brief");
        assert.strictEqual(brief?.text, '{"goal":"x"}');
        assert.strictEqual(brief?.origin, "developer-brief");
        assert.strictEqual(brief?.visibility, "internal");
        assert.strictEqual(brief?.bot_id, "bot-1");

        const voice = byId.get("voice");
        assert.strictEqual(voice?.text, "Created the file.");
        assert.strictEqual(voice?.origin, "bot");
        assert.strictEqual(voice?.visibility, null);
        assert.strictEqual(voice?.bot_id, "bot-1");

        assert.strictEqual(byId.get("voice-inline")?.text, "Done.");
        assert.strictEqual(byId.get("voice-inline")?.origin, "bot");

        assert.strictEqual(byId.get("plain")?.text, "hello");
        assert.strictEqual(byId.get("plain")?.origin, null);
        assert.strictEqual(byId.get("mention")?.text, "see [[hybrid:partner]] in docs");
        assert.strictEqual(byId.get("mention")?.origin, null);
        assert.strictEqual(byId.get("wake")?.origin, "system-wake");
      }),
    );
  },
);
