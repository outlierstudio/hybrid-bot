/**
 * // HYBRID: the one header of a Hybrid turn in the timeline.
 *
 * The thinking row (before the reply exists) and the assistant row render this same header at
 * the same position and size, so the handoff is invisible. Its status slot keeps a fixed
 * height for the whole turn: text changes crossfade (opacity only) and an idle turn leaves the
 * slot empty instead of collapsing it. The pop runs once, when the turn first appears.
 */
import type { BotSnapshot } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { PartnerFace } from "./PartnerFace";
import type { PartnerPresence } from "./partnerPresence";

export type TurnHeaderPhase = "thinking" | "streaming" | "completed";

/** Shared by both rows: the header's element role and its reserved size never change. */
export const TURN_HEADER_ELEMENT = "hybrid-turn-header";
export const TURN_HEADER_HEIGHT_CLASS = "h-7";

export interface TurnHeaderModel {
  readonly element: typeof TURN_HEADER_ELEMENT;
  readonly heightClass: typeof TURN_HEADER_HEIGHT_CLASS;
  /** "" keeps the slot (and its height) with nothing in it. */
  readonly status: string;
  readonly tone: "live" | "waiting" | "quiet";
  /** Only the first appearance of a turn pops. */
  readonly pop: boolean;
  /** The face hops only when a card needs the user. */
  readonly attention: boolean;
}

/**
 * What a turn header shows. `isLatest` is false for older turns, whose slot stays empty.
 * Developer work after the reply (working / waiting) keeps speaking on the latest header.
 */
export function turnHeaderModel(input: {
  readonly phase: TurnHeaderPhase;
  readonly isLatest: boolean;
  readonly presence: PartnerPresence | null;
}): TurnHeaderModel {
  const { phase, isLatest, presence } = input;
  const live = presence !== null && presence.kind !== "ready" ? presence : null;
  const status = !isLatest
    ? ""
    : live !== null
      ? live.text
      : phase === "thinking"
        ? "Thinking…"
        : phase === "streaming"
          ? "Writing…"
          : "";
  return {
    element: TURN_HEADER_ELEMENT,
    heightClass: TURN_HEADER_HEIGHT_CLASS,
    status,
    tone: live?.kind === "waiting" && isLatest ? "waiting" : status.length > 0 ? "live" : "quiet",
    pop: phase === "thinking",
    attention: isLatest && live?.kind === "waiting",
  };
}

export function HybridTurnHeader(props: {
  readonly snapshot: BotSnapshot;
  readonly model: TurnHeaderModel;
}) {
  const { snapshot, model } = props;
  return (
    <div
      data-turn-header={model.element}
      className={cn(
        "mb-1.5 flex items-center gap-2",
        model.heightClass,
        model.pop && "hybrid-turn-pop",
      )}
    >
      <PartnerFace color={snapshot.color} className="size-6" attention={model.attention} />
      <span className="shrink-0 text-sm font-medium leading-5">{snapshot.name}</span>
      {/* Fixed-height slot for the whole turn; never mounts or unmounts mid-turn. */}
      <span className="relative h-5 min-w-0 flex-1" aria-live="polite">
        {model.status.length > 0 ? (
          <span
            key={model.status}
            className={cn(
              "hybrid-turn-status inline-flex h-5 max-w-full items-center rounded-full border border-border/70 bg-card px-2 text-xs",
              model.tone === "waiting" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="truncate">{model.status}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}
