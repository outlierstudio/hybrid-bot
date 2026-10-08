import type { Bot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { botListFromStream } from "./useBots";

const bot = (id: string, archivedAt: string | null = null) =>
  ({ id, handle: id, name: id, archivedAt }) as unknown as Bot;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useBots stream", () => {
  it("a stream event updates the list without a refresh", async () => {
    const queue = Effect.runSync(Queue.unbounded<{ readonly bots: ReadonlyArray<Bot> }>());
    const atom = Atom.make(botListFromStream(Stream.fromQueue(queue)));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);
    const current = () => {
      const result = registry.get(atom);
      return AsyncResult.isSuccess(result) ? result.value.map((entry) => entry.id) : null;
    };

    expect(current()).toBeNull();
    Effect.runSync(Queue.offer(queue, { bots: [bot("engineer")] }));
    await settle();
    expect(current()).toEqual(["engineer"]);

    // A bot hatched or archived elsewhere arrives as the next full list.
    Effect.runSync(Queue.offer(queue, { bots: [bot("engineer"), bot("research", "2026-01-01")] }));
    await settle();
    expect(current()).toEqual(["engineer", "research"]);
    unmount();
  });
});
