import type { Bot } from "@t3tools/contracts";

import { PartnerFace } from "./PartnerFace";
import { usePartnerBotId } from "./partnerSelection";
import { PresenceBubble, usePartnerPresence } from "./PresenceBubble";
import { useBots } from "./useBots";

function lineFor(bot: Bot): string {
  switch (bot.handle) {
    case "hybrid":
    case "engineer":
      return "Tell me what you want changed. I’ll take it from there.";
    case "research":
      return "Ask me whatever you want to understand.";
    case "reviewer":
      return "Tell me what you want a second look at.";
    case "planner":
      return "Say what you’re trying to do. I’ll sort out the rest.";
    default:
      return "Talk to me in plain words. I’ll handle the work.";
  }
}

/** The empty chat is the bot, waiting. */
export function BotWelcome() {
  const { bots } = useBots();
  const partnerBotId = usePartnerBotId();
  const bot = bots.find((candidate) => candidate.id === partnerBotId) ?? bots[0] ?? null;
  const presence = usePartnerPresence(); // HYBRID
  if (!bot) {
    return <p className="text-sm text-muted-foreground">Send a message to start.</p>;
  }

  return (
    <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        {/* HYBRID: the live status pops out of the face. */}
        {presence !== null ? <PresenceBubble presence={presence} /> : null}
        <PartnerFace color={bot.color} className="size-16" gaze="cursor" blink />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium tracking-tight text-foreground">{bot.name}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{lineFor(bot)}</p>
      </div>
    </div>
  );
}
