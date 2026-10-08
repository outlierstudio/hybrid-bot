/**
 * // HYBRID: thread kind/parent/partner binding + project default partner bot.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
    `;
  }
  if (!threadColumns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "partner_bot_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN partner_bot_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread
    ON projection_threads(parent_thread_id)
  `;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "default_partner_bot_id")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN default_partner_bot_id TEXT`;
  }
});
