/**
 * // HYBRID: user-written approval rules (AUDIT §5.7). Scope is global, a project, or a bot.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS policy_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT,
      action_text TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_policy_rules_scope ON policy_rules(scope, scope_id)
  `;
});
