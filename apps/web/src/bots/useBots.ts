/**
 * // HYBRID: the bot list for the web client, live from `bots.subscribe`.
 *
 * The server sends the full list once, then again after every change (create, edit,
 * archive, reset), so callers never refresh. One stream per environment is shared by
 * every caller.
 */
import { WS_METHODS, type Bot } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { BOT_FEATURES, pickableBots } from "./botFeatures";

/** Returned while the first list is loading, so memoized maps don't rebuild every render. */
export const EMPTY_BOTS: ReadonlyArray<Bot> = [];

/** Each stream item is the whole list; keep only the bots. */
export const botListFromStream = <E, R>(
  stream: Stream.Stream<{ readonly bots: ReadonlyArray<Bot> }, E, R>,
): Stream.Stream<ReadonlyArray<Bot>, E, R> => stream.pipe(Stream.map((event) => event.bots));

export const botsSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "hybrid:bots",
  tag: WS_METHODS.subscribeBots,
  transform: botListFromStream,
});

export function useBots() {
  const environmentId = usePrimaryEnvironmentId();
  const atom = environmentId ? botsSubscription({ environmentId, input: {} }) : null;
  const query = useEnvironmentQuery(atom);
  const allBots = query.data ?? EMPTY_BOTS;
  // Pickers and mentions only show bots the user can pick (live, and only Hybrid with
  // multi-bot off); Settings still needs archived ones when multi-bot is on. An archived or
  // unknown @handle is plain text, so byHandle only holds pickable bots.
  const bots = useMemo(() => pickableBots(allBots), [allBots]);
  const archivedBots = useMemo(
    () => (BOT_FEATURES.botList ? allBots.filter((bot) => bot.archivedAt !== null) : EMPTY_BOTS),
    [allBots],
  );
  const byHandle = useMemo(() => {
    const map = new Map<string, Bot>();
    for (const bot of bots) map.set(bot.handle, bot);
    return map;
  }, [bots]);
  // Every bot, archived included, so old threads still find their faces and names.
  const byId = useMemo(() => {
    const map = new Map<string, Bot>();
    for (const bot of allBots) map.set(bot.id, bot);
    return map;
  }, [allBots]);

  return {
    bots,
    archivedBots,
    allBots,
    byHandle,
    byId,
    isPending: query.isPending,
    error: query.error,
  };
}
