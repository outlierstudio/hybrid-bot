/**
 * // HYBRID: structured Always-allow rules (approval_class + match_detail) for
 * deterministic matching without a reviewer model.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(policy_rules)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("approval_class")) {
    yield* sql`ALTER TABLE policy_rules ADD COLUMN approval_class TEXT`;
  }
  if (!has("match_detail")) {
    yield* sql`ALTER TABLE policy_rules ADD COLUMN match_detail TEXT`;
  }
});
