import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  diffDeveloperTaskNotices,
  type DeveloperTaskStateBaseline,
} from "../bots/developerTaskNotices";
import { useDeveloperTaskList } from "../bots/useDeveloperTasks";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environments.map(({ environmentId }) => environmentId));
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environments]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onNotification={onNotification}
    />
  ));
}

interface ThreadAlert {
  readonly title: string;
  readonly description: string;
  readonly sound: "input" | "completion";
  readonly appearance: "completion" | "approval" | "failed" | "input";
}

type PresentThreadAlert = (
  thread: { readonly id: ThreadId; readonly title: string },
  alert: ThreadAlert,
) => void;

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );

  // One presentation for every alert: sound, an in-app toast while the user is here looking
  // at another thread, or a desktop notification while they are away.
  const present = useCallback<PresentThreadAlert>(
    (thread, alert) => {
      if (hasNotificationSound(mode)) {
        void playNotificationSound(alert.sound, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
      ) {
        const toastId = toastManager.add({
          type:
            alert.appearance === "completion"
              ? "success"
              : alert.appearance === "failed"
                ? "error"
                : "warning",
          title: alert.title,
          description: alert.description,
          data: {
            hideCopyButton: true,
            leadingIcon:
              alert.appearance === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : alert.appearance === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : alert.appearance === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
        return;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      try {
        const notification = new Notification(alert.title, {
          body: alert.description,
          tag: `${environmentId}:${thread.id}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    },
    [
      activeEnvironmentId,
      activeThreadId,
      environmentId,
      inAppNotificationsEnabled,
      mode,
      navigate,
      onNotification,
    ],
  );

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    for (const thread of shell.snapshot.value.threads) {
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestTurn?.state === "error") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed"
          ? `${thread.latestTurn?.turnId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      present(thread, {
        title:
          kind === "completion"
            ? "Thread completed"
            : status === "approval"
              ? "Approval needed"
              : status === "failed"
                ? "Thread failed"
                : "Input needed",
        description: thread.title,
        sound: kind,
        appearance:
          kind === "completion"
            ? "completion"
            : status === "approval"
              ? "approval"
              : status === "failed"
                ? "failed"
                : "input",
      });
    }
    previous.current = next;
  }, [present, shell]);

  // HYBRID: a partner thread's developer tasks are not on the thread shell, so each live
  // partner thread is watched for its tasks ending. Waiting on the user needs no watcher: an
  // open decision card already flags the thread's shell as needing input.
  const partnerThreads =
    shell.status === "live" && Option.isSome(shell.snapshot)
      ? shell.snapshot.value.threads.filter(
          (thread) => thread.partnerBotId != null && thread.archivedAt === null,
        )
      : [];

  return partnerThreads.map((thread) => (
    <PartnerTaskNotifications
      key={thread.id}
      environmentId={environmentId}
      thread={thread}
      present={present}
    />
  ));
}

function PartnerTaskNotifications({
  environmentId,
  thread,
  present,
}: {
  environmentId: EnvironmentId;
  thread: { readonly id: ThreadId; readonly title: string };
  present: PresentThreadAlert;
}) {
  const tasks = useDeveloperTaskList({
    environmentId,
    parentThreadId: thread.id,
    enabled: true,
  });
  const baseline = useRef<DeveloperTaskStateBaseline>(null);

  useEffect(() => {
    if (tasks === null) return;
    const diff = diffDeveloperTaskNotices(baseline.current, tasks);
    baseline.current = diff.baseline;
    for (const notice of diff.notices) {
      present(thread, {
        title: notice.kind === "completed" ? "Developer task completed" : "Developer task failed",
        description: notice.goal,
        sound: "completion",
        appearance: notice.kind === "completed" ? "completion" : "failed",
      });
    }
  }, [present, tasks, thread]);

  return null;
}
