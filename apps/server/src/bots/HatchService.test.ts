/**
 * Hatch tests use a FAKE TextGeneration. Nothing here reaches a real provider.
 */
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type HatchTurnResult, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as HatchService from "./HatchService.ts";

const SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-fake",
} as unknown as ModelSelection;

const READY: HatchTurnResult = {
  say: "building smartie.",
  spec: {
    name: "Smartie",
    job: "listens and follows up",
    sendsDeveloper: false,
    limits: "",
    purpose: "Listens and follows up.",
    instructions: "You listen first.",
    tone: 30,
  },
};

interface Capture {
  cwd: string | null;
  model: string | null;
  calls: number;
}

const fakeTextGeneration = (capture: Capture, result: HatchTurnResult) =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("fake: unused"),
      generatePrContent: () => Effect.die("fake: unused"),
      generateBranchName: () => Effect.die("fake: unused"),
      generateThreadTitle: () => Effect.die("fake: unused"),
      generateHatchTurn: (input) =>
        Effect.sync(() => {
          capture.cwd = input.cwd;
          capture.model = input.modelSelection.model;
          capture.calls += 1;
          return result;
        }),
    }),
  );

const layerFor = (capture: Capture, result: HatchTurnResult = READY) =>
  HatchService.layer.pipe(
    Layer.provide(fakeTextGeneration(capture, result)),
    Layer.provide(serverSettingsLayerTest()),
    Layer.provide(NodeServices.layer),
  );

describe("HatchService", () => {
  it.effect("runs the hatch turn in a temp-dir cwd, not the server cwd", () => {
    const capture: Capture = { cwd: null, model: null, calls: 0 };
    return Effect.gen(function* () {
      const hatch = yield* HatchService.HatchService;
      const first = yield* hatch.hatchTurn({
        messages: [{ role: "user", text: "a bot that listens" }],
        modelSelection: SELECTION as never,
      });
      assert.deepEqual(first, READY);
      assert.equal(capture.model, "gpt-fake");
      assert.ok(capture.cwd !== null);
      assert.notEqual(capture.cwd, process.cwd());
      assert.ok(capture.cwd.startsWith(NodeOS.tmpdir()));
      assert.ok(capture.cwd.includes(HatchService.HATCH_TEMP_PREFIX));
      const firstCwd = capture.cwd;
      yield* hatch.hatchTurn({
        messages: [{ role: "user", text: "again" }],
        modelSelection: SELECTION as never,
      });
      assert.equal(capture.cwd, firstCwd);
      assert.equal(capture.calls, 2);
    }).pipe(Effect.provide(layerFor(capture)));
  });

  it.effect("falls back to the person's default model when none is passed", () => {
    const capture: Capture = { cwd: null, model: null, calls: 0 };
    return Effect.gen(function* () {
      const hatch = yield* HatchService.HatchService;
      const result = yield* hatch.hatchTurn({ messages: [{ role: "user", text: "hi" }] });
      assert.deepEqual(result, READY);
      assert.equal(capture.calls, 1);
      assert.equal(capture.model, "gpt-from-settings");
    }).pipe(
      Effect.provide(
        HatchService.layer.pipe(
          Layer.provide(fakeTextGeneration(capture, READY)),
          Layer.provide(
            serverSettingsLayerTest({
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-from-settings",
              },
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
