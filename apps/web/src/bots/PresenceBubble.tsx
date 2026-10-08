/**
 * // HYBRID: Hybrid's one live status, as a small speech-bubble pill.
 *
 * On the empty state it pops in just above the big face. Once the chat has messages, the
 * status lives in Hybrid's turn header instead (HybridTurnHeader).
 */
import { HYBRID_BOT_COLOR } from "@t3tools/contracts";
import { createContext, use } from "react";

import { cn } from "../lib/utils";
import { PartnerFace } from "./PartnerFace";
import type { PartnerPresence } from "./partnerPresence";

/** The partner thread's presence, or null on threads without one (read-only, work). */
export const PartnerPresenceContext = createContext<PartnerPresence | null>(null);

export function usePartnerPresence(): PartnerPresence | null {
  return use(PartnerPresenceContext);
}

export function PresenceBubble(props: {
  readonly presence: PartnerPresence;
  /** A tiny face in front of the text, for the timeline placement. */
  readonly withFace?: boolean;
  readonly className?: string;
}) {
  const { presence } = props;
  return (
    <div
      role="status"
      aria-live="polite"
      data-presence-kind={presence.kind}
      className={cn(
        "presence-bubble relative inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs",
        presence.kind === "waiting" ? "text-foreground" : "text-muted-foreground",
        props.className,
      )}
    >
      {props.withFace ? <PartnerFace color={HYBRID_BOT_COLOR} className="size-3.5" /> : null}
      <span className="min-w-0 truncate">{presence.text}</span>
    </div>
  );
}
