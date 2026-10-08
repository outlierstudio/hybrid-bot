/**
 * // HYBRID: the bots each thread has used, one row per (thread, bot) (AUDIT F3).
 *
 * Replaces scanning every message's bot_snapshot_json on each snapshot and shell load.
 * Backfilled from existing messages; the first message per bot wins.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_bots (
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      first_used_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, bot_id)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_bots (
      thread_id, bot_id, handle, name, color, first_used_at
    )
    SELECT
      thread_id,
      COALESCE(bot_id, json_extract(bot_snapshot_json, '$.handle')),
      json_extract(bot_snapshot_json, '$.handle'),
      json_extract(bot_snapshot_json, '$.name'),
      json_extract(bot_snapshot_json, '$.color'),
      created_at
    FROM projection_thread_messages
    WHERE bot_snapshot_json IS NOT NULL
      AND json_valid(bot_snapshot_json)
      AND json_extract(bot_snapshot_json, '$.handle') IS NOT NULL
      AND json_extract(bot_snapshot_json, '$.name') IS NOT NULL
      AND json_extract(bot_snapshot_json, '$.color') IS NOT NULL
    ORDER BY created_at ASC, rowid ASC
  `;
});
