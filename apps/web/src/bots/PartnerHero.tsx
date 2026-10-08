import type { Bot } from "@t3tools/contracts";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { PartnerFace } from "./PartnerFace";
import { usePartnerBotId, usePartnerSelectionActions } from "./partnerSelection";
import { BOT_FEATURES } from "./botFeatures";
import { PresenceBubble, usePartnerPresence } from "./PresenceBubble";
import { useBots } from "./useBots";

function greeting(bot: Bot | null): string {
  switch (bot?.handle) {
    case "hybrid":
    case "engineer":
      return "Tell me what you want built. I’ll look through the project, then send a developer to make the change.";
    case "research":
      return "Ask how this project works. I’ll read the code and only call a developer if you want something changed.";
    case "reviewer":
      return "I can look at the current changes and tell you what I’d fix.";
    case "planner":
      return "Describe the job. I’ll write the plan, and send a developer when you want it done.";
    default:
      return "Pick someone to talk to. They’ll handle the looking-around, and send a developer when code should change.";
  }
}

export function PartnerHero(props: { readonly projectName?: string | null } = {}) {
  const { bots } = useBots();
  const partnerBotId = usePartnerBotId();
  const { selectPartnerBot } = usePartnerSelectionActions();
  const partner = bots.find((bot) => bot.id === partnerBotId) ?? null;
  const presence = usePartnerPresence(); // HYBRID
  const [greetingOpen, setGreetingOpen] = useState(false);
  const namesVisible = bots.length <= 4;

  return (
    <div className="flex flex-col items-center gap-4">
      {partner ? (
        <div className="flex flex-col items-center gap-2">
          {/* HYBRID: the live status pops out of the face. */}
          {presence !== null ? <PresenceBubble presence={presence} /> : null}
          <PartnerFace color={partner.color} className="size-14" gaze="cursor" blink />
        </div>
      ) : (
        <div className="size-14 rounded-[22px] bg-muted" />
      )}
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            {partner ? partner.name : "Who do you want to talk to?"}
          </h1>
          {partner ? (
            <button
              type="button"
              aria-expanded={greetingOpen}
              aria-label={greetingOpen ? "Minimize" : "Maximize"}
              onClick={() => setGreetingOpen((open) => !open)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {greetingOpen ? (
                <Minimize2Icon className="size-4" />
              ) : (
                <Maximize2Icon className="size-4" />
              )}
            </button>
          ) : null}
        </div>
        {/* HYBRID: one plain line under the name. */}
        {partner && props.projectName ? (
          <p className="text-sm text-muted-foreground">
            What are we working on in {props.projectName}?
          </p>
        ) : null}
        {greetingOpen ? (
          <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
            {greeting(partner)}
          </p>
        ) : null}
      </div>
      {BOT_FEATURES.botList && bots.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {bots.map((bot) => {
            const selected = bot.id === partner?.id;
            return (
              <button
                key={bot.id}
                type="button"
                aria-pressed={selected}
                aria-label={bot.name}
                onClick={() => selectPartnerBot(bot.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border text-sm transition-colors",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  namesVisible ? "px-2.5 py-1.5" : "p-1",
                  selected
                    ? "border-foreground/30 bg-foreground/5 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PartnerFace color={bot.color} className="size-6" />
                {namesVisible ? bot.name : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
