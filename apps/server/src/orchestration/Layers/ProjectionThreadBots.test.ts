// HYBRID: projection_thread_bots — projector upsert and the used-bots read (AUDIT F3).
import {
  BotId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
    ),
  ),
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-bots-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT_ID = ProjectId.make("project-thread-bots");
const THREAD_ID = ThreadId.make("thread-bots");
const ENGINEER: BotSnapshot = {
  handle: "engineer",
  name: "Engineer",
  color: "#3366ff",
} as BotSnapshot;
const RESEARCH: BotSnapshot = {
  handle: "research",
  name: "Research",
  color: "#22aa55",
} as BotSnapshot;

/** The pre-063 used-bots read, kept here to prove the new table answers the same. */
const legacyUsedBots = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ botSnapshot: string }>`
    SELECT bot_snapshot_json AS "botSnapshot"
    FROM projection_thread_messages
    WHERE bot_snapshot_json IS NOT NULL AND thread_id = ${threadId}
    ORDER BY created_at ASC
  `.pipe(
    Effect.map((rows) => {
      const list: BotSnapshot[] = [];
      for (const row of rows) {
        const snapshot = JSON.parse(row.botSnapshot) as BotSnapshot;
        if (!list.some((bot) => bot.handle === snapshot.handle)) list.push(snapshot);
      }
      return list;
    }),
  );

it.layer(TestLayer)("projection_thread_bots", (it) => {
  it.effect("upserts one row per bot on message-sent and the shell reads them", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const events = yield* OrchestrationEventStore;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      const fields = (id: string, occurredAt: string) => ({
        eventId: EventId.make(`evt-${id}`),
        aggregateKind: "thread" as const,
        aggregateId: THREAD_ID,
        occurredAt,
        commandId: CommandId.make(`cmd-${id}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
      });
      const project = (event: Parameters<typeof events.append>[0]) =>
        events.append(event).pipe(Effect.flatMap(pipeline.projectEvent));

      yield* project({
        type: "project.created",
        eventId: EventId.make("evt-project"),
        aggregateKind: "project",
        aggregateId: PROJECT_ID,
        occurredAt: "2026-09-01T00:00:00.000Z",
        commandId: CommandId.make("cmd-project"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId: PROJECT_ID,
          title: "Bots",
          workspaceRoot: "/tmp/thread-bots",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      });
      yield* project({
        type: "thread.created",
        ...fields("thread", "2026-09-01T00:00:00.000Z"),
        payload: {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      });

      const message = (
        id: string,
        at: string,
        bot?: { readonly botId: string; readonly snapshot: BotSnapshot },
        streaming = false,
      ) =>
        project({
          type: "thread.message-sent",
          ...fields(`${id}-${at}`, at),
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make(id),
            role: "assistant",
            text: id,
            turnId: null,
            streaming,
            ...(bot !== undefined
              ? { botId: BotId.make(bot.botId), botSnapshot: bot.snapshot }
              : {}),
            createdAt: at,
            updatedAt: at,
          },
        });

      yield* message("m1", "2026-09-01T00:01:00.000Z");
      yield* message(
        "m2",
        "2026-09-01T00:02:00.000Z",
        { botId: "bot-eng", snapshot: ENGINEER },
        true,
      );
      yield* message("m2", "2026-09-01T00:02:30.000Z", { botId: "bot-eng", snapshot: ENGINEER });
      yield* message("m3", "2026-09-01T00:03:00.000Z", {
        botId: "bot-research",
        snapshot: RESEARCH,
      });
      // A later message from a renamed Engineer keeps the first snapshot.
      yield* message("m4", "2026-09-01T00:04:00.000Z", {
        botId: "bot-eng",
        snapshot: { ...ENGINEER, name: "Renamed" } as BotSnapshot,
      });

      const rows = yield* sql<{ botId: string; handle: string; name: string; firstUsedAt: string }>`
        SELECT bot_id AS "botId", handle, name, first_used_at AS "firstUsedAt"
        FROM projection_thread_bots WHERE thread_id = ${THREAD_ID}
        ORDER BY first_used_at
      `;
      assert.deepEqual(rows, [
        {
          botId: "bot-eng",
          handle: "engineer",
          name: "Engineer",
          firstUsedAt: "2026-09-01T00:02:00.000Z",
        },
        {
          botId: "bot-research",
          handle: "research",
          name: "Research",
          firstUsedAt: "2026-09-01T00:03:00.000Z",
        },
      ]);

      const shell = Option.getOrThrow(yield* snapshots.getThreadShellById(THREAD_ID));
      assert.deepEqual(shell.usedBots, [ENGINEER, RESEARCH]);
      assert.deepEqual(shell.usedBots, yield* legacyUsedBots(sql, THREAD_ID));
      const snapshot = yield* snapshots.getShellSnapshot();
      assert.deepEqual(snapshot.threads.find((thread) => thread.id === THREAD_ID)?.usedBots, [
        ENGINEER,
        RESEARCH,
      ]);
    }),
  );
});
