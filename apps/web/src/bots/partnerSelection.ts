/**
 * HYBRID: partner binding for the active chat.
 *
 * Persisted threads store `partnerBotId` (via `thread.partner.set`). Drafts
 * keep a session preference until create stamps it (or inherits the project
 * default when the draft preference was never overridden).
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { HYBRID_BOT_ID, HYBRID_MULTI_BOT, type BotId } from "@t3tools/contracts";

let modelAuto = true;
const modelListeners = new Set<() => void>();

function emitModel() {
  for (const listener of modelListeners) listener();
}

export function getModelAuto(): boolean {
  return modelAuto;
}

export function setModelAuto(next: boolean) {
  if (modelAuto === next) return;
  modelAuto = next;
  emitModel();
}

export function useModelAuto(): boolean {
  return useSyncExternalStore(
    (listener) => {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
    getModelAuto,
    getModelAuto,
  );
}

/**
 * Project default associate, falling back to Hybrid. With multi-bot off every new thread
 * starts with Hybrid, whatever a project default from an older version says.
 */
export function projectDefaultPartnerBotId(
  defaultPartnerBotId: BotId | null | undefined,
  multiBot: boolean = HYBRID_MULTI_BOT,
): BotId {
  return multiBot ? (defaultPartnerBotId ?? HYBRID_BOT_ID) : HYBRID_BOT_ID;
}

type PartnerBindingContextValue = {
  readonly partnerBotId: BotId | null;
  readonly selectPartnerBot: (id: BotId) => void;
  readonly dismissPartnerBot: () => void;
};

const PartnerBindingContext = createContext<PartnerBindingContextValue | null>(null);

type PartnerBridge = {
  readonly get: () => BotId | null;
  readonly wasDismissed: () => boolean;
  readonly select: (id: BotId) => void;
  readonly dismiss: () => void;
  readonly subscribe: (listener: () => void) => () => void;
};

let activeBridge: PartnerBridge | null = null;
const bridgeListeners = new Set<() => void>();

function emitBridge() {
  for (const listener of bridgeListeners) listener();
}

// A bot to open the next draft chat with (Hatch → new chat). Consumed once by the next
// draft PartnerBindingProvider so it beats the project default. `lastTaken` covers
// React StrictMode remount (initializer → clear → remount initializer).
let pendingDraftPartnerBotId: BotId | null = null;
let lastTakenDraftPartnerBotId: BotId | null = null;
let lastTakenDraftPartnerBotAt = 0;

export function setPendingDraftPartnerBot(id: BotId | null): void {
  pendingDraftPartnerBotId = id;
  if (id !== null) {
    lastTakenDraftPartnerBotId = null;
    lastTakenDraftPartnerBotAt = 0;
  }
}

export function peekPendingDraftPartnerBot(): BotId | null {
  if (pendingDraftPartnerBotId !== null) return pendingDraftPartnerBotId;
  // Short window so StrictMode remount still sees the pick; long enough for
  // the effect→unmount→remount cycle, short enough not to leak into the next draft.
  if (lastTakenDraftPartnerBotId !== null && Date.now() - lastTakenDraftPartnerBotAt < 250) {
    return lastTakenDraftPartnerBotId;
  }
  return null;
}

function clearPendingDraftPartnerBot(): void {
  if (pendingDraftPartnerBotId !== null) {
    lastTakenDraftPartnerBotId = pendingDraftPartnerBotId;
    lastTakenDraftPartnerBotAt = Date.now();
  }
  pendingDraftPartnerBotId = null;
}

// Standalone fallback used by Hatch / sidebar when ChatView is not mounted.
let standalonePartnerBotId: BotId | null = HYBRID_BOT_ID;
let standaloneDismissed = false;

const standaloneBridge: PartnerBridge = {
  get: () => (standaloneDismissed ? null : standalonePartnerBotId),
  wasDismissed: () => standaloneDismissed,
  select: (id) => {
    standaloneDismissed = false;
    standalonePartnerBotId = id;
    emitBridge();
  },
  dismiss: () => {
    standaloneDismissed = true;
    standalonePartnerBotId = null;
    emitBridge();
  },
  subscribe: (listener) => {
    bridgeListeners.add(listener);
    return () => bridgeListeners.delete(listener);
  },
};

activeBridge = standaloneBridge;

export function PartnerBindingProvider(props: {
  readonly children: ReactNode;
  /**
   * When provided (including null), the active server thread owns the binding.
   * Omit the prop entirely for local drafts.
   */
  readonly threadPartnerBotId?: BotId | null | undefined;
  readonly projectDefaultPartnerBotId?: BotId | null | undefined;
  readonly onPersistPartner?: ((partnerBotId: BotId | null) => void) | undefined;
}) {
  const isServerThread = props.threadPartnerBotId !== undefined;
  // Peek only: initializers can run twice (StrictMode). The mount effect clears it.
  const [openedWithPickedBot] = useState(
    () => !isServerThread && peekPendingDraftPartnerBot() !== null,
  );
  const [draftPartnerBotId, setDraftPartnerBotId] = useState<BotId | null>(
    () =>
      (isServerThread ? null : peekPendingDraftPartnerBot()) ??
      projectDefaultPartnerBotId(props.projectDefaultPartnerBotId),
  );
  const [draftDismissed, setDraftDismissed] = useState(false);
  useEffect(() => {
    clearPendingDraftPartnerBot();
  }, []);

  // Keep draft preference aligned with project default until the user picks.
  useEffect(() => {
    if (isServerThread || draftDismissed) return;
    if (standaloneDismissed) return;
    if (openedWithPickedBot) return;
    setDraftPartnerBotId(projectDefaultPartnerBotId(props.projectDefaultPartnerBotId));
  }, [draftDismissed, isServerThread, openedWithPickedBot, props.projectDefaultPartnerBotId]);

  const partnerBotId = isServerThread
    ? (props.threadPartnerBotId ?? null)
    : draftDismissed
      ? null
      : draftPartnerBotId;

  const onPersistPartner = props.onPersistPartner;
  const selectPartnerBot = useCallback(
    (id: BotId) => {
      if (isServerThread) {
        onPersistPartner?.(id);
        return;
      }
      setDraftDismissed(false);
      setDraftPartnerBotId(id);
      standaloneDismissed = false;
      standalonePartnerBotId = id;
      emitBridge();
    },
    [isServerThread, onPersistPartner],
  );

  const dismissPartnerBot = useCallback(() => {
    if (isServerThread) {
      onPersistPartner?.(null);
      return;
    }
    setDraftDismissed(true);
    setDraftPartnerBotId(null);
    standaloneDismissed = true;
    standalonePartnerBotId = null;
    emitBridge();
  }, [isServerThread, onPersistPartner]);

  const value = useMemo<PartnerBindingContextValue>(
    () => ({ partnerBotId, selectPartnerBot, dismissPartnerBot }),
    [dismissPartnerBot, partnerBotId, selectPartnerBot],
  );

  useEffect(() => {
    const bridge: PartnerBridge = {
      get: () => partnerBotId,
      wasDismissed: () => partnerBotId === null,
      select: selectPartnerBot,
      dismiss: dismissPartnerBot,
      subscribe: (listener) => {
        bridgeListeners.add(listener);
        return () => bridgeListeners.delete(listener);
      },
    };
    activeBridge = bridge;
    emitBridge();
    return () => {
      activeBridge = standaloneBridge;
      emitBridge();
    };
  }, [dismissPartnerBot, partnerBotId, selectPartnerBot]);

  return createElement(PartnerBindingContext.Provider, { value }, props.children);
}

function usePartnerBinding(): PartnerBindingContextValue {
  const ctx = useContext(PartnerBindingContext);
  const bridgePartnerBotId = useSyncExternalStore(
    (listener) => {
      bridgeListeners.add(listener);
      return () => bridgeListeners.delete(listener);
    },
    () => activeBridge?.get() ?? null,
    () => activeBridge?.get() ?? null,
  );
  if (ctx) return ctx;
  // Outside ChatView (Hatch / roster / tests): mirror the imperative bridge.
  return {
    partnerBotId: bridgePartnerBotId,
    selectPartnerBot: (id) => activeBridge?.select(id),
    dismissPartnerBot: () => activeBridge?.dismiss(),
  };
}

export function usePartnerBotId(): BotId | null {
  return usePartnerBinding().partnerBotId;
}

export function usePartnerSelectionActions(): {
  readonly selectPartnerBot: (id: BotId) => void;
  readonly dismissPartnerBot: () => void;
} {
  const { selectPartnerBot, dismissPartnerBot } = usePartnerBinding();
  return { selectPartnerBot, dismissPartnerBot };
}

export function getPartnerBotId(): BotId | null {
  return activeBridge?.get() ?? null;
}

export function wasPartnerDismissed(): boolean {
  return activeBridge?.wasDismissed() ?? false;
}

export function subscribePartnerBot(listener: () => void): () => void {
  bridgeListeners.add(listener);
  return () => bridgeListeners.delete(listener);
}

export function selectPartnerBot(id: BotId): void {
  activeBridge?.select(id);
}

export function dismissPartnerBot(): void {
  activeBridge?.dismiss();
}
