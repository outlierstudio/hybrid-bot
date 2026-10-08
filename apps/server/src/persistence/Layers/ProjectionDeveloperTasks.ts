/**
 * // HYBRID: SQLite layer for the developer-task projection.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionDeveloperTaskInput,
  ListProjectionDeveloperTasksByParentThreadInput,
  ProjectionDeveloperTask,
  ProjectionDeveloperTaskDbRowSchema,
  ProjectionDeveloperTaskRepository,
  type ProjectionDeveloperTaskRepositoryShape,
} from "../Services/ProjectionDeveloperTasks.ts";

const makeProjectionDeveloperTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionDeveloperTask,
    execute: (row) => sql`
      INSERT INTO projection_developer_tasks (
        task_id,
        parent_thread_id,
        parent_turn_id,
        work_thread_id,
        work_turn_ids_json,
        bot_id,
        brief_json,
        runtime_mode,
        model_selection_json,
        state,
        pending_request_json,
        result_json,
        failure_json,
        created_at,
        updated_at,
        started_at,
        completed_at
      )
      VALUES (
        ${row.taskId},
        ${row.parentThreadId},
        ${row.parentTurnId},
        ${row.workThreadId},
        ${JSON.stringify(row.workTurnIds)},
        ${row.botId},
        ${JSON.stringify(row.brief)},
        ${row.runtimeMode},
        ${JSON.stringify(row.modelSelection)},
        ${row.state},
        ${row.pendingRequest === null ? null : JSON.stringify(row.pendingRequest)},
        ${row.result === null ? null : JSON.stringify(row.result)},
        ${row.failure === null ? null : JSON.stringify(row.failure)},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.startedAt},
        ${row.completedAt}
      )
      ON CONFLICT (task_id)
      DO UPDATE SET
        parent_thread_id = excluded.parent_thread_id,
        parent_turn_id = excluded.parent_turn_id,
        work_thread_id = excluded.work_thread_id,
        work_turn_ids_json = excluded.work_turn_ids_json,
        bot_id = excluded.bot_id,
        brief_json = excluded.brief_json,
        runtime_mode = excluded.runtime_mode,
        model_selection_json = excluded.model_selection_json,
        state = excluded.state,
        pending_request_json = excluded.pending_request_json,
        result_json = excluded.result_json,
        failure_json = excluded.failure_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionDeveloperTaskInput,
    Result: ProjectionDeveloperTaskDbRowSchema,
    execute: ({ taskId }) => sql`
      SELECT
        task_id AS "taskId",
        parent_thread_id AS "parentThreadId",
        parent_turn_id AS "parentTurnId",
        work_thread_id AS "workThreadId",
        work_turn_ids_json AS "workTurnIds",
        bot_id AS "botId",
        brief_json AS "brief",
        runtime_mode AS "runtimeMode",
        model_selection_json AS "modelSelection",
        state,
        pending_request_json AS "pendingRequest",
        result_json AS "result",
        failure_json AS "failure",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM projection_developer_tasks
      WHERE task_id = ${taskId}
    `,
  });

  const listByParentThreadRows = SqlSchema.findAll({
    Request: ListProjectionDeveloperTasksByParentThreadInput,
    Result: ProjectionDeveloperTaskDbRowSchema,
    execute: ({ parentThreadId }) => sql`
      SELECT
        task_id AS "taskId",
        parent_thread_id AS "parentThreadId",
        parent_turn_id AS "parentTurnId",
        work_thread_id AS "workThreadId",
        work_turn_ids_json AS "workTurnIds",
        bot_id AS "botId",
        brief_json AS "brief",
        runtime_mode AS "runtimeMode",
        model_selection_json AS "modelSelection",
        state,
        pending_request_json AS "pendingRequest",
        result_json AS "result",
        failure_json AS "failure",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM projection_developer_tasks
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionDeveloperTaskDbRowSchema,
    execute: () => sql`
      SELECT
        task_id AS "taskId",
        parent_thread_id AS "parentThreadId",
        parent_turn_id AS "parentTurnId",
        work_thread_id AS "workThreadId",
        work_turn_ids_json AS "workTurnIds",
        bot_id AS "botId",
        brief_json AS "brief",
        runtime_mode AS "runtimeMode",
        model_selection_json AS "modelSelection",
        state,
        pending_request_json AS "pendingRequest",
        result_json AS "result",
        failure_json AS "failure",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM projection_developer_tasks
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const upsert: ProjectionDeveloperTaskRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionDeveloperTaskRepository.upsert:query")),
    );

  const getById: ProjectionDeveloperTaskRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionDeveloperTaskRepository.getById:query")),
    );

  const listByParentThreadId: ProjectionDeveloperTaskRepositoryShape["listByParentThreadId"] = (
    input,
  ) =>
    listByParentThreadRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionDeveloperTaskRepository.listByParentThreadId:query"),
      ),
    );

  const listAll: ProjectionDeveloperTaskRepositoryShape["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionDeveloperTaskRepository.listAll:query")),
    );

  return {
    upsert,
    getById,
    listByParentThreadId,
    listAll,
  } satisfies ProjectionDeveloperTaskRepositoryShape;
});

export const ProjectionDeveloperTaskRepositoryLive = Layer.effect(
  ProjectionDeveloperTaskRepository,
  makeProjectionDeveloperTaskRepository,
);
