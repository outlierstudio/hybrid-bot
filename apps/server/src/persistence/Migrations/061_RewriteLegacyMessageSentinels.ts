/**
 * // HYBRID: AUDIT Phase 6 — rewrite legacy protocol sentinels once.
 *
 * Before typed `origin` / `visibility` existed, the partner protocol marked
 * messages with text prefixes:
 *   `[[hybrid:harness-brief]]` — a private brief sent to the coding harness
 *   `[[hybrid:partner]]`       — the partner bot's user-facing voice
 *
 * Projection rows are rewritten to typed fields and the prefix is stripped, so
 * readers no longer need the sentinels. The orchestration event log is left
 * untouched (append-only); `isUserVisibleMessage` keeps a read-time fallback in
 * case a projection is ever rebuilt from old events.
 *
 * Idempotent: rows without a sentinel prefix are never selected.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HARNESS_BRIEF_PREFIX = "[[hybrid:harness-brief]]";
const PARTNER_VOICE_PREFIX = "[[hybrid:partner]]";

function stripPrefix(text: string, prefix: string): string {
  return text
    .slice(prefix.length)
    .replace(/^\r?\n/, "")
    .trim();
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const briefs = yield* sql<{ readonly message_id: string; readonly text: string }>`
    SELECT message_id, text FROM projection_thread_messages
    WHERE substr(text, 1, ${HARNESS_BRIEF_PREFIX.length}) = ${HARNESS_BRIEF_PREFIX}
  `;
  for (const row of briefs) {
    yield* sql`
      UPDATE projection_thread_messages
      SET text = ${stripPrefix(row.text, HARNESS_BRIEF_PREFIX)},
          origin = 'developer-brief',
          visibility = 'internal'
      WHERE message_id = ${row.message_id}
    `;
  }

  // bot_id / bot_snapshot_json are left alone: attribution is preserved.
  const voices = yield* sql<{ readonly message_id: string; readonly text: string }>`
    SELECT message_id, text FROM projection_thread_messages
    WHERE substr(text, 1, ${PARTNER_VOICE_PREFIX.length}) = ${PARTNER_VOICE_PREFIX}
  `;
  for (const row of voices) {
    yield* sql`
      UPDATE projection_thread_messages
      SET text = ${stripPrefix(row.text, PARTNER_VOICE_PREFIX)},
          origin = 'bot'
      WHERE message_id = ${row.message_id}
    `;
  }
});
