// HYBRID: users only ever talk to Hybrid (HYBRID_DEVELOPER_DIRECT off).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  HYBRID_BOT_ID,
  HYBRID_DEVELOPER_DIRECT,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  applyHybridPartnerRules,
  normalizeDispatchCommand,
  PARTNERLESS_TURN_MESSAGE,
  rejectsPartnerlessTurn,
} from "./Normalizer.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-10-08T00:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const threadWith = (partnerBotId: BotId | null, kind: "chat" | "work" = "chat") =>
  ({ id: ThreadId.make("thread-old"), kind, partnerBotId }) as unknown as OrchestrationThreadShell;

const layerWithThread = (thread: OrchestrationThreadShell) =>
  Layer.mergeAll(
    WorkspacePaths.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-hybrid-" }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeedSome(thread),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const turnStart = (botId?: BotId) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("client-turn"),
    threadId: ThreadId.make("thread-old"),
    message: { messageId: MessageId.make("m1"), role: "user", text: "hi", attachments: [] },
    ...(botId !== undefined ? { botId } : {}),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  }) satisfies ClientOrchestrationCommand;

const partnerSet = (partnerBotId: BotId | null) =>
  ({
    type: "thread.partner.set",
    commandId: CommandId.make("client-partner"),
    threadId: ThreadId.make("thread-old"),
    partnerBotId,
    createdAt: NOW,
  }) satisfies ClientOrchestrationCommand;

const threadCreate = (partnerBotId?: BotId | null) =>
  ({
    type: "thread.create",
    commandId: CommandId.make("client-create"),
    threadId: ThreadId.make("thread-new"),
    projectId: ProjectId.make("project-1"),
    title: "New thread",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    ...(partnerBotId !== undefined ? { partnerBotId } : {}),
  }) satisfies ClientOrchestrationCommand;

describe("applyHybridPartnerRules", () => {
  it("ships with Developer directly off", () => {
    expect(HYBRID_DEVELOPER_DIRECT).toBe(false);
  });

  it("off: new chat threads get Hybrid, and the partner can't be cleared", () => {
    const created = applyHybridPartnerRules(threadCreate(), false);
    expect(
      "command" in created && created.command.type === "thread.create"
        ? created.command.partnerBotId
        : undefined,
    ).toBe(HYBRID_BOT_ID);
    const explicitNull = applyHybridPartnerRules(threadCreate(null), false);
    expect(
      "command" in explicitNull && explicitNull.command.type === "thread.create"
        ? explicitNull.command.partnerBotId
        : undefined,
    ).toBe(HYBRID_BOT_ID);
    expect(applyHybridPartnerRules(partnerSet(null), false)).toHaveProperty("error");
    expect(applyHybridPartnerRules(partnerSet(HYBRID_BOT_ID), false)).toHaveProperty("command");
  });

  it("on: the old behaviour is back", () => {
    expect(applyHybridPartnerRules(partnerSet(null), true)).toEqual({ command: partnerSet(null) });
    expect(applyHybridPartnerRules(threadCreate(), true)).toEqual({ command: threadCreate() });
  });
});

describe("rejectsPartnerlessTurn", () => {
  it("off: refuses turns on partnerless chat threads only", () => {
    expect(rejectsPartnerlessTurn(threadWith(null), undefined, false)).toBe(true);
    expect(rejectsPartnerlessTurn(threadWith(HYBRID_BOT_ID), undefined, false)).toBe(false);
    expect(rejectsPartnerlessTurn(threadWith(null, "work"), undefined, false)).toBe(false);
    expect(rejectsPartnerlessTurn(threadWith(null), HYBRID_BOT_ID, false)).toBe(false);
  });

  it("on: allows them", () => {
    expect(rejectsPartnerlessTurn(threadWith(null), undefined, true)).toBe(false);
  });
});

describe("normalizeDispatchCommand (Developer directly off)", () => {
  it.effect("rejects thread.partner.set to null", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand(partnerSet(null)).pipe(Effect.flip);
      expect(error.message).toContain("can't be cleared");
    }).pipe(Effect.provide(layerWithThread(threadWith(HYBRID_BOT_ID)))),
  );

  it.effect("rejects a turn on an old partnerless chat thread with a clear error", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand(turnStart()).pipe(Effect.flip);
      expect(error.message).toBe(PARTNERLESS_TURN_MESSAGE);
    }).pipe(Effect.provide(layerWithThread(threadWith(null)))),
  );

  it.effect("accepts a turn once the thread talks to Hybrid", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStart());
      expect(normalized.type).toBe("thread.turn.start");
    }).pipe(Effect.provide(layerWithThread(threadWith(HYBRID_BOT_ID)))),
  );

  it.effect("server-minted turns are not affected", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStart(), { origin: "server" });
      expect(normalized.type).toBe("thread.turn.start");
    }).pipe(Effect.provide(layerWithThread(threadWith(null)))),
  );
});

describe("thread detail stream", () => {
  it("delivers thread.partner-set, so an open thread sees Continue with Hybrid land", async () => {
    const { isThreadDetailEvent } = await import("../ws.ts");
    expect(
      isThreadDetailEvent({ type: "thread.partner-set" } as Parameters<
        typeof isThreadDetailEvent
      >[0]),
    ).toBe(true);
  });
});
