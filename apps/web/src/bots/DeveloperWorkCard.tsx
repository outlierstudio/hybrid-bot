import type { ThreadId } from "@t3tools/contracts";
import { memo, useEffect, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  canStopDeveloperTask,
  DEVELOPER_TASK_STATE_LABEL,
  developerWorkElapsedMs,
  formatDeveloperTaskElapsed,
  isDeveloperTaskLive,
  type DeveloperWorkCardModel,
} from "./developerWork";

const PILL_TONE: Record<DeveloperWorkCardModel["state"], string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-info/10 text-info-foreground",
  "waiting-on-bot": "bg-info/10 text-info-foreground",
  "waiting-on-user": "bg-warning/10 text-warning-foreground",
  completed: "bg-success/10 text-success-foreground",
  failed: "bg-destructive/10 text-destructive-foreground",
  canceled: "bg-muted text-muted-foreground",
};

const CHECK_TONE = {
  passed: "text-success-foreground",
  failed: "text-destructive-foreground",
  unknown: "text-muted-foreground",
} as const;

const VISIBLE_FILES = 4;

/** Re-renders once a second while the task is live, so the elapsed clock moves. */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);
  return nowMs;
}

export const DeveloperWorkCard = memo(function DeveloperWorkCard(props: {
  readonly work: DeveloperWorkCardModel;
  /** Null when this client cannot stop tasks. */
  readonly onStop: ((taskId: string) => Promise<unknown>) | null;
  /** Null when there is no diff surface to open. */
  readonly onShowDiff: (() => void) | null;
  /** Renders the read-only timeline of the work thread. Null hides Show work. */
  readonly renderWorkThread: ((workThreadId: ThreadId) => ReactNode) | null;
}) {
  const { work, onStop, onShowDiff, renderWorkThread } = props;
  const live = isDeveloperTaskLive(work.state);
  const nowMs = useNowMs(live);
  const [stopping, setStopping] = useState(false);
  const [showWork, setShowWork] = useState(false);

  const elapsedMs = developerWorkElapsedMs(work, nowMs);
  const stop = () => {
    if (onStop === null || stopping) return;
    setStopping(true);
    // The pill flips to Stopped with the server's state. A failed call puts the button back.
    void onStop(work.taskId).finally(() => setStopping(false));
  };

  const detail =
    work.pendingSummary ??
    work.liveStatus ??
    work.failureMessage ??
    (live ? null : work.resultSummary);
  const canShowWork = work.workThreadId !== null && renderWorkThread !== null;
  const hiddenFiles = Math.max(0, work.files.length - VISIBLE_FILES);

  return (
    <div
      className="relative w-full max-w-[80%] rounded-2xl border border-border bg-card px-3 py-2.5 text-card-foreground"
      data-testid="developer-work-card"
      data-task-state={work.state}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium wrap-break-word">{work.goal}</p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            PILL_TONE[work.state],
          )}
          data-testid="developer-work-state"
        >
          {DEVELOPER_TASK_STATE_LABEL[work.state]}
        </span>
        {elapsedMs !== null ? (
          <span
            className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
            data-testid="developer-work-elapsed"
          >
            {formatDeveloperTaskElapsed(elapsedMs)}
          </span>
        ) : null}
      </div>

      {detail !== null ? (
        <p
          className="mt-1 text-xs text-muted-foreground wrap-break-word"
          data-testid="developer-work-beat"
        >
          {detail}
        </p>
      ) : null}

      {work.files.length > 0 ? (
        <div className="mt-2 space-y-0.5" data-testid="developer-work-files">
          <p className="text-xs text-muted-foreground">
            {work.files.length === 1 ? "1 file changed" : `${work.files.length} files changed`}{" "}
            <span className="text-success-foreground">+{work.additions}</span>{" "}
            <span className="text-destructive-foreground">-{work.deletions}</span>
          </p>
          {work.files.slice(0, VISIBLE_FILES).map((file) => (
            <p key={file.path} className="flex gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-success-foreground">+{file.additions}</span>{" "}
                <span className="text-destructive-foreground">-{file.deletions}</span>
              </span>
            </p>
          ))}
          {hiddenFiles > 0 ? (
            <p className="text-xs text-muted-foreground">and {hiddenFiles} more</p>
          ) : null}
        </div>
      ) : null}

      {work.checks.length > 0 ? (
        <ul className="mt-2 space-y-0.5" data-testid="developer-work-checks">
          {work.checks.map((check) => (
            <li key={check.command} className="flex gap-2 text-xs">
              <span className={cn("shrink-0", CHECK_TONE[check.outcome])}>
                {check.outcome === "passed"
                  ? "Passed"
                  : check.outcome === "failed"
                    ? "Failed"
                    : "Ran"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {check.command}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        {canShowWork ? (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showWork}
            onClick={() => setShowWork((open) => !open)}
          >
            {showWork ? "Hide work" : "Show work"}
          </Button>
        ) : null}
        {onShowDiff !== null && work.workThreadId !== null ? (
          <Button size="sm" variant="ghost" onClick={onShowDiff}>
            Show diff
          </Button>
        ) : null}
        {canStopDeveloperTask(work.state) ? (
          <Button size="sm" variant="ghost" disabled={onStop === null || stopping} onClick={stop}>
            Stop
          </Button>
        ) : null}
      </div>

      {showWork && canShowWork && work.workThreadId !== null ? (
        <div
          className="mt-2.5 h-80 overflow-hidden rounded-xl border border-border bg-background"
          data-testid="developer-work-thread"
        >
          {renderWorkThread(work.workThreadId)}
        </div>
      ) : null}
    </div>
  );
});
