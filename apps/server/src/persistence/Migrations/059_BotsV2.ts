/**
 * // HYBRID: Bot v2 columns (purpose/tone/autonomy/engines/seed bookkeeping).
 * Legacy columns stay in place and readable for one release.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(bots)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("purpose")) {
    yield* sql`ALTER TABLE bots ADD COLUMN purpose TEXT NOT NULL DEFAULT ''`;
  }
  if (!has("tone")) {
    yield* sql`ALTER TABLE bots ADD COLUMN tone INTEGER NOT NULL DEFAULT 50`;
  }
  if (!has("autonomy")) {
    yield* sql`ALTER TABLE bots ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'small-changes'`;
  }
  if (!has("can_delegate")) {
    yield* sql`ALTER TABLE bots ADD COLUMN can_delegate INTEGER NOT NULL DEFAULT 1`;
  }
  if (!has("partner_engine_json")) {
    yield* sql`ALTER TABLE bots ADD COLUMN partner_engine_json TEXT`;
  }
  if (!has("developer_engine_json")) {
    yield* sql`ALTER TABLE bots ADD COLUMN developer_engine_json TEXT`;
  }
  if (!has("seed_version")) {
    yield* sql`ALTER TABLE bots ADD COLUMN seed_version INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("user_modified")) {
    yield* sql`ALTER TABLE bots ADD COLUMN user_modified INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("archived_at")) {
    yield* sql`ALTER TABLE bots ADD COLUMN archived_at TEXT`;
  }
});
