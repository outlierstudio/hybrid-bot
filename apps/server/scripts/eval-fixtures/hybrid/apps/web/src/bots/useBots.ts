/** Central hook for the user's bot list: bots, byHandle, byId, refresh, isPending. */
export function useBots() {
  return { bots: [], byHandle: new Map(), byId: new Map(), refresh: () => {}, isPending: false };
}
