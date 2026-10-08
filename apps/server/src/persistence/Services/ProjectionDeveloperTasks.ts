/**
 * // HYBRID: ProjectionDeveloperTaskRepository - projection repository for developer tasks.
 *
 * Owns persistence operations for projected developer-task (delegation) records.
 *
 * @module ProjectionDeveloperTaskRepository
 */
import {
  DeveloperTask,
  DeveloperTaskFailure,
  DeveloperTaskId,
  DeveloperTaskPendingRequest,
  DeveloperTaskResult,
  ThreadId,
  TurnId,
  DeveloperTaskBrief,
  DeveloperTaskModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionDeveloperTask = DeveloperTask;
export type ProjectionDeveloperTask = typeof ProjectionDeveloperTask.Type;

/** Row shape as stored: structured fields are JSON text. */
export const ProjectionDeveloperTaskDbRowSchema = ProjectionDeveloperTask.mapFields(
  Struct.assign({
    workTurnIds: Schema.fromJsonString(Schema.Array(TurnId)),
    brief: Schema.fromJsonString(DeveloperTaskBrief),
    modelSelection: Schema.fromJsonString(DeveloperTaskModelSelection),
    pendingRequest: Schema.NullOr(Schema.fromJsonString(DeveloperTaskPendingRequest)),
    result: Schema.NullOr(Schema.fromJsonString(DeveloperTaskResult)),
    failure: Schema.NullOr(Schema.fromJsonString(DeveloperTaskFailure)),
  }),
);

export const GetProjectionDeveloperTaskInput = Schema.Struct({
  taskId: DeveloperTaskId,
});
export type GetProjectionDeveloperTaskInput = typeof GetProjectionDeveloperTaskInput.Type;

export const ListProjectionDeveloperTasksByParentThreadInput = Schema.Struct({
  parentThreadId: ThreadId,
});
export type ListProjectionDeveloperTasksByParentThreadInput =
  typeof ListProjectionDeveloperTasksByParentThreadInput.Type;

export interface ProjectionDeveloperTaskRepositoryShape {
  /** Insert or replace a projected developer task. Upserts by `taskId`. */
  readonly upsert: (
    task: ProjectionDeveloperTask,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionDeveloperTaskInput,
  ) => Effect.Effect<Option.Option<ProjectionDeveloperTask>, ProjectionRepositoryError>;

  /** Tasks started from one chat thread, oldest first. */
  readonly listByParentThreadId: (
    input: ListProjectionDeveloperTasksByParentThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionDeveloperTask>, ProjectionRepositoryError>;

  /** Every task, oldest first. */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionDeveloperTask>,
    ProjectionRepositoryError
  >;
}

export class ProjectionDeveloperTaskRepository extends Context.Service<
  ProjectionDeveloperTaskRepository,
  ProjectionDeveloperTaskRepositoryShape
>()("t3/persistence/Services/ProjectionDeveloperTasks/ProjectionDeveloperTaskRepository") {}
