import type { BotSnapshot } from "@t3tools/contracts";

import { PartnerFace } from "./PartnerFace";

/** The bots a thread has used, from the server's thread shell. */
export function SidebarThreadBots(props: {
  readonly usedBots?: readonly BotSnapshot[] | undefined;
}) {
  const bots = props.usedBots ?? [];
  if (bots.length === 0) return null;

  return (
    <span
      className="flex shrink-0 items-center -space-x-1"
      aria-label={bots.map((bot) => bot.name).join(", ")}
    >
      {bots.slice(0, 4).map((bot) => (
        <PartnerFace key={bot.handle} color={bot.color} className="size-4 ring-2 ring-sidebar" />
      ))}
    </span>
  );
}
