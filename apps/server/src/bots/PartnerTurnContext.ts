/**
 * HYBRID: gathers the facts for a partner turn's `<partner_context>` (AUDIT F5).
 *
 * Best effort and quick: every source is optional, bounded by a timeout, and a failure only
 * leaves its line out. Git status is the local, cached-or-refreshed working tree (no fetch).
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionDeveloperTaskRepository } from "../persistence/Services/ProjectionDeveloperTasks.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildPartnerContext, type PartnerContextInput } from "./partnerContext.ts";

const SOURCE_TIMEOUT = Duration.seconds(2);

export interface PartnerTurnContextInput {
  readonly threadId: ThreadId;
  /** The partner's worktree or project root. */
  readonly cwd: string | null;
  /** The thread's branch, used when git status is unavailable. */
  readonly branch: string | null;
}

export class PartnerTurnContext extends Context.Service<
  PartnerTurnContext,
  { readonly build: (input: PartnerTurnContextInput) => Effect.Effect<string | null> }
>()("t3/bots/PartnerTurnContext") {}

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(SOURCE_TIMEOUT), Effect.option);

const make = Effect.gen(function* () {
  const tasks = yield* ProjectionDeveloperTaskRepository;
  const vcs = yield* Effect.serviceOption(VcsStatusBroadcaster);

  const build: PartnerTurnContext["Service"]["build"] = Effect.fn("PartnerTurnContext.build")(
    function* (input) {
      const status =
        input.cwd !== null && Option.isSome(vcs)
          ? yield* bounded(vcs.value.refreshLocalStatus(input.cwd))
          : Option.none();
      const local = Option.getOrUndefined(status);
      const taskRows = yield* bounded(
        tasks.listByParentThreadId({ parentThreadId: input.threadId }),
      );
      const context: PartnerContextInput = {
        branch: local?.isRepo ? (local.refName ?? input.branch) : input.branch,
        uncommittedFiles: local?.isRepo ? local.workingTree.files.length : null,
        tasks: Option.getOrElse(taskRows, () => []).map((task) => ({
          taskId: task.taskId,
          goal: task.brief.goal,
          state: task.state,
        })),
      };
      return buildPartnerContext(context);
    },
  );

  return { build } satisfies PartnerTurnContext["Service"];
});

/** Needs the developer task projection; uses VcsStatusBroadcaster if present. */
export const layer = Layer.effect(PartnerTurnContext, make);
