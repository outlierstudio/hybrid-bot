/**
 * Partner presence above the composer.
 */
import type { Bot } from "@t3tools/contracts";

import { PartnerFace } from "./PartnerFace";

export function BotChip(props: {
  readonly bot: Bot;
  readonly inline?: boolean;
  readonly onClear?: () => void;
}) {
  return (
    <div
      data-partner-chip="true"
      className={props.inline ? "flex items-center" : "mb-2 flex items-center gap-2"}
    >
      <PartnerFace color={props.bot.color} className={props.inline ? "size-6" : "size-8"} />
      {props.inline ? null : (
        <p className="min-w-0 truncate text-sm font-medium leading-tight">{props.bot.name}</p>
      )}
    </div>
  );
}
