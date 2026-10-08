import type { BotSnapshot } from "@t3tools/contracts";

import { PartnerFace } from "./PartnerFace";

export type BotWorkBeat = { readonly id: string; readonly text: string };

function latestBeat(beats: readonly BotWorkBeat[]): BotWorkBeat {
  return beats[beats.length - 1] ?? { id: "heard", text: "on it" };
}

function isTyping(beat: BotWorkBeat): boolean {
  return beat.id === "write";
}

function isOnProject(beat: BotWorkBeat): boolean {
  return beat.id === "harness" || beat.id === "draft" || beat.id === "computer";
}

function TypingBubble() {
  return (
    <span className="partner-typing-bubble" aria-hidden>
      <span className="partner-dot" />
      <span className="partner-dot" />
      <span className="partner-dot" />
    </span>
  );
}

function ProjectMark() {
  return (
    <span className="partner-project" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/** One line next to the face. Typing is a small chat bubble, not a status clock. */
export function BotPresence(props: {
  readonly snapshot: BotSnapshot;
  readonly beats?: readonly BotWorkBeat[];
  readonly faceClassName?: string;
}) {
  const beats = props.beats ?? [];
  const live = beats.length > 0;
  const beat = latestBeat(beats);
  const typing = live && isTyping(beat);
  const onProject = live && isOnProject(beat);

  return (
    <div
      className="flex items-start gap-2.5"
      data-bot-working={live ? props.snapshot.handle : undefined}
    >
      <PartnerFace
        color={props.snapshot.color}
        {...(live && !typing ? { looking: true } : {})}
        className={props.faceClassName ?? "size-7"}
      />
      {live ? (
        <span className="flex flex-col gap-1">
          <span className="partner-line pt-1 text-sm text-muted-foreground/70" key={beat.id}>
            {`${props.snapshot.name} is ${beat.text}..`}
          </span>
          {typing ? <TypingBubble /> : onProject ? <ProjectMark /> : null}
          <span className="sr-only">{`is ${beat.text}`}</span>
        </span>
      ) : (
        <span className="pt-1 text-sm font-medium leading-5">{props.snapshot.name}</span>
      )}
    </div>
  );
}

/** Shown before the reply exists. Once text starts, the same presence stays on the message. */
export function BotWorkingStatus(props: {
  readonly snapshot: BotSnapshot;
  readonly beats: readonly BotWorkBeat[];
}) {
  return (
    <div className="px-1 py-1">
      <BotPresence snapshot={props.snapshot} beats={props.beats} faceClassName="size-8" />
    </div>
  );
}
