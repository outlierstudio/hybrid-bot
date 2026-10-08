/**
 * // HYBRID: developer-task projection table + typed message provenance columns.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_developer_tasks (
      task_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL,
      work_thread_id TEXT,
      work_turn_ids_json TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      state TEXT NOT NULL,
      pending_request_json TEXT,
      result_json TEXT,
      failure_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_developer_tasks_parent_thread
    ON projection_developer_tasks(parent_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_developer_tasks_work_thread
    ON projection_developer_tasks(work_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_developer_tasks_state
    ON projection_developer_tasks(state)
  `;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  // NULL = absent on the event = the default ("user" origin, "user" visibility, no task).
  if (!messageColumns.some((column) => column.name === "origin")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN origin TEXT`;
  }
  if (!messageColumns.some((column) => column.name === "visibility")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN visibility TEXT`;
  }
  if (!messageColumns.some((column) => column.name === "developer_task_id")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN developer_task_id TEXT`;
  }
});
