import { cn } from "../lib/utils";
import type { ThreadRowState } from "./partnerPresence";

const LABEL: Record<ThreadRowState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  "done-unread": "Done",
};

/** HYBRID: a tiny static dot for a thread's state. No animation: rows repaint for free. */
export function ThreadStateDot(props: { readonly state: ThreadRowState | null }) {
  if (props.state === null) return null;
  return (
    <span
      role="img"
      aria-label={LABEL[props.state]}
      title={LABEL[props.state]}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.state === "needs-you" && "bg-amber-500 dark:bg-amber-300",
        props.state === "working" && "bg-sky-500 dark:bg-sky-300/80",
        props.state === "done-unread" && "bg-emerald-500 dark:bg-emerald-300/90",
      )}
    />
  );
}
