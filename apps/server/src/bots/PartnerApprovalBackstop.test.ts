import { BotId, EventId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as PartnerApprovalBackstop from "./PartnerApprovalBackstop.ts";
import { approvalRequested } from "./partnerEventFixtures.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const makeLayer = (
  commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  thread: { readonly kind?: "chat" | "work"; readonly partnerBotId?: BotId | null },
) =>
  PartnerApprovalBackstop.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(commands, (list) => [...list, command]).pipe(Effect.as({ sequence: 1 })),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeedSome({ ...thread } as never),
        }),
        Layer.succeed(Crypto.Crypto, testCrypto),
      ),
    ),
  );

const run = (thread: Parameters<typeof makeLayer>[1]) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const backstop = yield* PartnerApprovalBackstop.PartnerApprovalBackstop.pipe(
      Effect.provide(makeLayer(commands, thread)),
    );
    yield* backstop.handleActivity(
      approvalRequested({ sequence: 1, requestId: "req-1", detail: "rm -rf /" }) as never,
    );
    // Same request twice must only decline once.
    yield* backstop.handleActivity(
      approvalRequested({ sequence: 2, requestId: "req-1", detail: "rm -rf /" }) as never,
    );
    return yield* Ref.get(commands);
  });

describe("PartnerApprovalBackstop", () => {
  it.effect("declines approvals on a chat thread with a partnerBotId", () =>
    Effect.gen(function* () {
      const commands = yield* run({ kind: "chat", partnerBotId: BotId.make("bot-1") });
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command.type, "thread.approval.respond");
      if (command.type === "thread.approval.respond") {
        assert.equal(command.decision, "decline");
        assert.equal(command.requestId, "req-1");
      }
    }),
  );

  it.effect("leaves ordinary chat threads alone", () =>
    Effect.gen(function* () {
      assert.equal((yield* run({ kind: "chat", partnerBotId: null })).length, 0);
      assert.equal((yield* run({})).length, 0);
    }),
  );

  it.effect("leaves work threads alone", () =>
    Effect.gen(function* () {
      assert.equal((yield* run({ kind: "work", partnerBotId: BotId.make("bot-1") })).length, 0);
    }),
  );

  it.effect("ignores non-approval activities", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const backstop = yield* PartnerApprovalBackstop.PartnerApprovalBackstop.pipe(
        Effect.provide(makeLayer(commands, { kind: "chat", partnerBotId: BotId.make("bot-1") })),
      );
      const event = approvalRequested({ sequence: 3, requestId: "req-2", detail: "x" });
      if (event.type !== "thread.activity-appended") throw new Error("unexpected event");
      yield* backstop.handleActivity({
        ...event,
        payload: {
          ...event.payload,
          activity: { ...event.payload.activity, kind: "tool.completed", id: EventId.make("a") },
        },
      });
      assert.equal((yield* Ref.get(commands)).length, 0);
      assert.ok(ThreadId.make("t"));
    }),
  );
});
