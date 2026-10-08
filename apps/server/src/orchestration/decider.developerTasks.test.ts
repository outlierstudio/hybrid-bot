// HYBRID: developer-task / partner / provenance decider + projector coverage.
import {
  BotId,
  BUILTIN_BOT_IDS,
  HYBRID_BOT_ID,
  OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const CHAT_ID = ThreadId.make("thread-chat");
const WORK_ID = ThreadId.make("thread-work");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" } as const;

const baseThread = (id: ThreadId, kind: "chat" | "work", parentThreadId: ThreadId | null) => ({
  id,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: MODEL,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  kind,
  parentThreadId,
  partnerBotId: null,
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const makeReadModel = (): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      defaultPartnerBotId: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [baseThread(CHAT_ID, "chat", null), baseThread(WORK_ID, "work", CHAT_ID)],
  developerTasks: [],
  updatedAt: NOW,
});

const createTaskCommand = (commandId: string) => ({
  type: "developerTask.create",
  commandId,
  taskId: "task-1",
  parentThreadId: CHAT_ID,
  parentTurnId: "turn-1",
  botId: "bot-1",
  brief: { goal: "Ship it", context: "", constraints: "", acceptance: "", scope: "small" },
  runtimeMode: "full-access",
  modelSelection: MODEL,
  createdAt: NOW,
});

const asArray = (
  decided: PlannedEvent | ReadonlyArray<PlannedEvent>,
): ReadonlyArray<PlannedEvent> => (Array.isArray(decided) ? decided : [decided as PlannedEvent]);

it.layer(NodeServices.layer)("developer task decider", (it) => {
  it.effect("rejects client-sent developerTask commands but accepts server: ids", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const clientCommand = yield* decodeCommand(createTaskCommand("client-1"));
      const rejected = yield* Effect.flip(
        decideOrchestrationCommand({ readModel, command: clientCommand }),
      );
      expect(String(rejected.message)).toContain("server");

      const serverCommand = yield* decodeCommand(createTaskCommand("server:dt-1"));
      const events = asArray(
        yield* decideOrchestrationCommand({ readModel, command: serverCommand }),
      );
      expect(events.map((event) => event.type)).toEqual(["developer-task.created"]);
    }),
  );

  it.effect("projects created -> running -> completed and blocks terminal re-entry", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel();
      let sequence = 0;
      const apply = (decided: PlannedEvent | ReadonlyArray<PlannedEvent>) =>
        Effect.gen(function* () {
          for (const event of asArray(decided)) {
            sequence += 1;
            readModel = yield* projectEvent(readModel, {
              ...event,
              sequence,
            } as OrchestrationEvent);
          }
        });

      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand(createTaskCommand("server:dt-1")),
        }),
      );
      expect(readModel.developerTasks?.[0]?.state).toBe("queued");

      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.state.set",
            commandId: "server:dt-2",
            taskId: "task-1",
            state: "running",
            workThreadId: WORK_ID,
            createdAt: NOW,
          }),
        }),
      );
      expect(readModel.developerTasks?.[0]?.state).toBe("running");
      expect(readModel.developerTasks?.[0]?.workThreadId).toBe(WORK_ID);
      expect(readModel.developerTasks?.[0]?.startedAt).toBe(NOW);

      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.cancel",
            commandId: "server:dt-3",
            taskId: "task-1",
            createdAt: NOW,
          }),
        }),
      );
      expect(readModel.developerTasks?.[0]?.state).toBe("canceled");
      expect(readModel.developerTasks?.[0]?.completedAt).toBe(NOW);

      const again = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.cancel",
            commandId: "server:dt-4",
            taskId: "task-1",
            createdAt: NOW,
          }),
        }),
      );
      expect(again._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("sets the thread partner and rejects it on work threads", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const livePartner = { id: HYBRID_BOT_ID, archivedAt: null };
      const decided = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          partnerBot: livePartner,
          command: yield* decodeCommand({
            type: "thread.partner.set",
            commandId: "client-partner",
            threadId: CHAT_ID,
            partnerBotId: HYBRID_BOT_ID,
            createdAt: NOW,
          }),
        }),
      );
      expect(decided.map((event) => event.type)).toEqual(["thread.partner-set"]);
      const projected = yield* projectEvent(readModel, {
        ...decided[0]!,
        sequence: 1,
      } as OrchestrationEvent);
      expect(projected.threads.find((thread) => thread.id === CHAT_ID)?.partnerBotId).toBe(
        HYBRID_BOT_ID,
      );

      const cleared = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.partner.set",
            commandId: "client-partner-clear",
            threadId: CHAT_ID,
            partnerBotId: null,
            createdAt: NOW,
          }),
        }),
      );
      expect(cleared.map((event) => event.type)).toEqual(["thread.partner-set"]);

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          partnerBot: livePartner,
          command: yield* decodeCommand({
            type: "thread.partner.set",
            commandId: "client-partner-2",
            threadId: WORK_ID,
            partnerBotId: HYBRID_BOT_ID,
            createdAt: NOW,
          }),
        }),
      );
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("multi-bot off: partner.set only accepts Hybrid or null", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      for (const partnerBotId of [BUILTIN_BOT_IDS.research, "bot-custom"]) {
        const rejected = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            partnerBot: { id: partnerBotId, archivedAt: null },
            command: yield* decodeCommand({
              type: "thread.partner.set",
              commandId: `client-partner-${partnerBotId}`,
              threadId: CHAT_ID,
              partnerBotId,
              createdAt: NOW,
            }),
          }),
        );
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
        expect(String(rejected.message)).toContain("Only Hybrid");
      }
    }),
  );

  it.effect("rejects partner.set for missing or archived bots", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const missing = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          partnerBot: null,
          command: yield* decodeCommand({
            type: "thread.partner.set",
            commandId: "client-partner-missing",
            threadId: CHAT_ID,
            partnerBotId: HYBRID_BOT_ID,
            createdAt: NOW,
          }),
        }),
      );
      expect(String(missing.message)).toContain("not found");

      const archived = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          partnerBot: { id: HYBRID_BOT_ID, archivedAt: NOW },
          command: yield* decodeCommand({
            type: "thread.partner.set",
            commandId: "client-partner-archived",
            threadId: CHAT_ID,
            partnerBotId: HYBRID_BOT_ID,
            createdAt: NOW,
          }),
        }),
      );
      expect(String(archived.message)).toContain("archived");
    }),
  );

  it.effect("rejects client thread.create with kind work or parentThreadId", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const clientWork = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.create",
            commandId: "client-work",
            threadId: ThreadId.make("thread-client-work"),
            projectId: PROJECT_ID,
            title: "Work",
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            kind: "work",
            parentThreadId: CHAT_ID,
          }),
        }),
      );
      expect(String(clientWork.message)).toContain("server");

      const clientParent = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.create",
            commandId: "client-parent",
            threadId: ThreadId.make("thread-client-parent"),
            projectId: PROJECT_ID,
            title: "Child",
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            parentThreadId: CHAT_ID,
          }),
        }),
      );
      expect(String(clientParent.message)).toContain("server");

      const serverWork = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.create",
            commandId: "server:work-1",
            threadId: ThreadId.make("thread-server-work"),
            projectId: PROJECT_ID,
            title: "Work",
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            kind: "work",
            parentThreadId: CHAT_ID,
          }),
        }),
      );
      expect(serverWork[0]?.type).toBe("thread.created");
      expect((serverWork[0] as { payload: { kind?: string } }).payload.kind).toBe("work");
    }),
  );

  it.effect("steers a running task and projects the turn id", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel();
      let sequence = 0;
      const apply = (decided: PlannedEvent | ReadonlyArray<PlannedEvent>) =>
        Effect.gen(function* () {
          for (const event of asArray(decided)) {
            sequence += 1;
            readModel = yield* projectEvent(readModel, {
              ...event,
              sequence,
            } as OrchestrationEvent);
          }
        });

      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand(createTaskCommand("server:dt-steer-1")),
        }),
      );
      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.state.set",
            commandId: "server:dt-steer-2",
            taskId: "task-1",
            state: "running",
            workThreadId: WORK_ID,
            createdAt: NOW,
          }),
        }),
      );

      yield* apply(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.steer",
            commandId: "server:dt-steer-3",
            taskId: "task-1",
            text: "also add a test",
            turnId: "turn-steer-1",
            createdAt: NOW,
          }),
        }),
      );
      expect(readModel.developerTasks?.[0]?.workTurnIds).toContain("turn-steer-1");

      const clientSteer = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "developerTask.steer",
            commandId: "client-steer",
            taskId: "task-1",
            text: "nope",
            turnId: "turn-steer-2",
            createdAt: NOW,
          }),
        }),
      );
      expect(String(clientSteer.message)).toContain("server");
    }),
  );

  it.effect("inherits the project default partner on thread.create and projects it", () =>
    Effect.gen(function* () {
      const readModel: OrchestrationReadModel = {
        ...makeReadModel(),
        projects: [
          {
            ...makeReadModel().projects[0]!,
            defaultPartnerBotId: BotId.make("builtin-engineer"),
          },
        ],
        threads: [],
      };
      const nextThreadId = ThreadId.make("thread-new");
      const decided = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.create",
            commandId: "client-create",
            threadId: nextThreadId,
            projectId: PROJECT_ID,
            title: "New",
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          }),
        }),
      );
      expect(decided[0]?.type).toBe("thread.created");
      expect((decided[0] as { payload: { partnerBotId?: string } }).payload.partnerBotId).toBe(
        "builtin-engineer",
      );
      const projected = yield* projectEvent(readModel, {
        ...decided[0]!,
        sequence: 1,
      } as OrchestrationEvent);
      expect(projected.threads.find((thread) => thread.id === nextThreadId)?.partnerBotId).toBe(
        "builtin-engineer",
      );
    }),
  );

  it.effect("round-trips message origin/visibility from a server turn.start", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const decided = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* decodeCommand({
            type: "thread.turn.start",
            commandId: "server:wake-1",
            threadId: CHAT_ID,
            message: {
              messageId: "message-wake",
              role: "user",
              text: "wake digest",
              attachments: [],
              origin: "system-wake",
              visibility: "internal",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          }),
        }),
      );
      const sent = decided.find((event) => event.type === "thread.message-sent");
      expect(sent).toBeDefined();
      const projected = yield* projectEvent(readModel, {
        ...sent!,
        sequence: 1,
      } as OrchestrationEvent);
      const message = projected.threads
        .find((thread) => thread.id === CHAT_ID)
        ?.messages.find((entry) => entry.id === "message-wake");
      expect(message?.origin).toBe("system-wake");
      expect(message?.visibility).toBe("internal");
    }),
  );

  it.effect("rejects client turn.start with non-user provenance", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const turnStart = (message: Record<string, unknown>, commandId = "client-turn") =>
        decodeCommand({
          type: "thread.turn.start",
          commandId,
          threadId: CHAT_ID,
          message: {
            messageId: "message-1",
            role: "user",
            text: "hi",
            attachments: [],
            ...message,
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        });

      for (const message of [
        { origin: "bot" },
        { origin: "developer-brief" },
        { visibility: "internal" },
        { developerTaskId: "task-1" },
      ]) {
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({ readModel, command: yield* turnStart(message) }),
        );
        expect(failure._tag).toBe("OrchestrationCommandInvariantError");
      }

      const ok = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* turnStart({ origin: "user", visibility: "user" }, "client-turn-ok"),
        }),
      );
      expect(ok.some((event) => event.type === "thread.message-sent")).toBe(true);

      const serverOk = asArray(
        yield* decideOrchestrationCommand({
          readModel,
          command: yield* turnStart(
            { origin: "developer-brief", visibility: "internal", developerTaskId: "task-1" },
            "server:turn-1",
          ),
        }),
      );
      expect(serverOk.some((event) => event.type === "thread.message-sent")).toBe(true);
    }),
  );
});
