import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { memo, useMemo, useRef } from "react";

import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { useTheme } from "../hooks/useTheme";
import { deriveTimelineEntriesWithState, deriveWorkLogEntries } from "../session-logic";
import { useThread } from "../state/entities";

const NOOP = () => {};

/**
 * Read-only timeline of a developer task's work thread, drawn inside the work card.
 * It reuses the thread's own `MessagesTimeline` with every action turned off, so the
 * user sees exactly what the developer did without a second place to type.
 */
export const WorkThreadTimeline = memo(function WorkThreadTimeline(props: {
  readonly environmentId: EnvironmentId;
  readonly workThreadId: ThreadId;
}) {
  const { environmentId, workThreadId } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, workThreadId),
    [environmentId, workThreadId],
  );
  const threadKey = useMemo(() => scopedThreadKey(threadRef), [threadRef]);
  const thread = useThread(threadRef);
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();

  const workEntries = useMemo(
    () => deriveWorkLogEntries(thread?.activities ?? []),
    [thread?.activities],
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntriesWithState(
        thread?.messages ?? [],
        thread?.proposedPlans ?? [],
        workEntries,
      ).entries,
    [thread?.messages, thread?.proposedPlans, workEntries],
  );

  if (thread === null) {
    return <p className="p-3 text-xs text-muted-foreground">Loading the developer's work…</p>;
  }

  const latestTurn = thread.latestTurn ?? null;
  const runningTurnId =
    (thread.session?.status === "running" ? thread.session.activeTurnId : null) ??
    (latestTurn?.state === "running" ? latestTurn.turnId : null);
  const isWorking = runningTurnId !== null;

  return (
    <MessagesTimeline
      isWorking={isWorking}
      activeTurnStartedAt={isWorking ? (latestTurn?.startedAt ?? null) : null}
      listRef={listRef}
      timelineEntries={timelineEntries}
      latestTurn={latestTurn}
      runningTurnId={runningTurnId}
      turnDiffSummaries={thread.checkpoints}
      routeThreadKey={threadKey}
      onOpenTurnDiff={NOOP}
      supportsConversationRollback={false}
      onRevertToTurnCount={NOOP}
      isRevertingCheckpoint={false}
      onImageExpand={NOOP}
      activeThreadEnvironmentId={environmentId}
      markdownCwd={undefined}
      resolvedTheme={resolvedTheme}
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={NOOP}
      contentInsetEndAdjustment={0}
      liveFollowEnabled={isWorking}
      onIsAtEndChange={NOOP}
      onManualNavigation={NOOP}
      hideEmptyPlaceholder
      topFadeEnabled={false}
    />
  );
});
