/**
 * // HYBRID: bots table migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      instructions TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      runtime_mode TEXT NOT NULL,
      read_only INTEGER NOT NULL,
      mcp_servers_json TEXT NOT NULL,
      built_in INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS bots_handle_unique ON bots(handle)`;
});
