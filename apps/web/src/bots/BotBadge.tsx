/**
 * Who is speaking in the timeline.
 */
import type { BotSnapshot } from "@t3tools/contracts";

import { BotPresence, type BotWorkBeat } from "./BotWorkingStatus";

export function BotBadge(props: {
  readonly snapshot: BotSnapshot;
  readonly side?: "user" | "assistant";
  readonly working?: boolean;
  readonly beats?: readonly BotWorkBeat[];
}) {
  if (props.side === "user") return null;
  return (
    <div className="mb-1.5" data-bot-handle={props.snapshot.handle}>
      <BotPresence
        snapshot={props.snapshot}
        {...(props.working || (props.beats?.length ?? 0) > 0 ? { beats: props.beats ?? [] } : {})}
      />
    </div>
  );
}
