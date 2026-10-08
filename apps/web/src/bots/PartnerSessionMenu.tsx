import type { ReactNode } from "react";
import type { Bot, RuntimeMode } from "@t3tools/contracts";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";

import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { PartnerFace } from "./PartnerFace";
import { usePartnerBotId, usePartnerSelectionActions } from "./partnerSelection";

/** Talk-to switch plus access mode. "Developer directly" reaches the plain harness. */
export function PartnerSessionMenu(props: {
  readonly bots: readonly Bot[];
  readonly runtimeMode: RuntimeMode;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const partnerBotId = usePartnerBotId();
  const { selectPartnerBot, dismissPartnerBot } = usePartnerSelectionActions();
  const selectedBot =
    partnerBotId === null ? null : (props.bots.find((bot) => bot.id === partnerBotId) ?? null);

  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          selectedBot ? `Talking to ${selectedBot.name}` : "Talk to partner or developer directly"
        }
        className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {selectedBot ? (
          <>
            {/* HYBRID: just "Hybrid ▾"; the face lives in the top bar. */}
            <span className="max-w-24 truncate">{selectedBot.name}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </>
        ) : (
          <SlidersHorizontalIcon className="size-3.5" />
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <div className="flex flex-col gap-2">
          <p className="px-1 text-xs text-muted-foreground">Talk to</p>
          <div className="flex flex-col">
            {props.bots.map((bot) => {
              const selected = bot.id === partnerBotId;
              return (
                <TalkToOption
                  key={bot.id}
                  selected={selected}
                  label={bot.name}
                  face={<PartnerFace color={bot.color} className="size-3.5" />}
                  onSelect={() => selectPartnerBot(bot.id)}
                />
              );
            })}
            <TalkToOption
              selected={partnerBotId === null}
              label="Developer directly"
              onSelect={() => dismissPartnerBot()}
            />
          </div>
          {partnerBotId === null ? (
            <>
              <p className="px-1 pt-1 text-xs text-muted-foreground">Access</p>
              <div className="flex flex-col">
                {runtimeModeOptions.map((mode) => {
                  const option = runtimeModeConfig[mode];
                  const selected = mode === props.runtimeMode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => props.onRuntimeModeChange(mode)}
                      className={
                        selected
                          ? "rounded-md bg-foreground/8 px-2 py-1.5 text-left text-sm text-foreground"
                          : "rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function TalkToOption(props: {
  readonly selected: boolean;
  readonly label: string;
  readonly face?: ReactNode;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={
        props.selected
          ? "flex items-center gap-2 rounded-md bg-foreground/8 px-2 py-1.5 text-left text-sm text-foreground"
          : "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      }
    >
      {props.face}
      <span className="truncate">{props.label}</span>
    </button>
  );
}
