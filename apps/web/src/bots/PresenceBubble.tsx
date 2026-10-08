/**
 * // HYBRID: Hybrid's one live status, as a small speech-bubble pill.
 *
 * On the empty state it pops in just above the big face; once the chat has messages it sits
 * just above Hybrid's newest (or in-progress) message. It updates in place (the text
 * changes, the element stays) and is hidden while idle in the timeline.
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

/** In the timeline the pill only shows while something is happening. */
export function shouldShowTimelinePresence(presence: PartnerPresence | null): boolean {
  return presence !== null && presence.kind !== "ready";
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

/** The timeline placement: above Hybrid's newest message, only while not idle. */
export function TimelinePresenceBubble() {
  const presence = usePartnerPresence();
  if (presence === null || !shouldShowTimelinePresence(presence)) return null;
  return (
    <div className="mb-1.5">
      <PresenceBubble presence={presence} withFace />
    </div>
  );
}
