/**
 * Hatch interview turns. They run on the person's selected model via
 * TextGeneration.
 *
 * Partner conversation turns are plain provider turns (ProviderCommandReactor +
 * partnerSessionProfile); approvals are declined by PartnerApprovalBackstop.
 */
import type { HatchTurnInput, HatchTurnResult, ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/**
 * Hatch talks to a model but never touches a project. Each turn runs in an empty
 * scratch directory under the OS temp dir, never the server's working directory.
 */
export const HATCH_TEMP_PREFIX = "hybrid-hatch-";

export class HatchService extends Context.Service<
  HatchService,
  {
    readonly hatchTurn: (input: HatchTurnInput) => Effect.Effect<HatchTurnResult, never>;
  }
>()("t3/bots/HatchService") {}

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const hatchCwd = yield* Effect.cached(
    fileSystem.makeTempDirectory({ prefix: HATCH_TEMP_PREFIX }).pipe(Effect.orDie),
  );

  const hatchTurn: HatchService["Service"]["hatchTurn"] = Effect.fn("HatchService.hatchTurn")(
    function* (input: HatchTurnInput) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const modelSelection = (input.modelSelection ??
        settings?.defaultModelSelection ??
        settings?.textGenerationModelSelection ??
        null) as ModelSelection | null;
      if (modelSelection === null) {
        return {
          say: "pick a model in settings first, then we can hatch.",
          spec: null,
        };
      }

      const cwd = yield* hatchCwd;
      const generated = yield* textGeneration
        .generateHatchTurn({
          cwd,
          messages: input.messages,
          modelSelection,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("hatch model turn failed", {
              detail: error.detail,
            }).pipe(Effect.as(null)),
          ),
        );
      if (generated === null) {
        return { say: "that didn't go through. try again.", spec: null };
      }
      return generated;
    },
  );

  return { hatchTurn } satisfies HatchService["Service"];
});

export const layer = Layer.effect(HatchService, make);
