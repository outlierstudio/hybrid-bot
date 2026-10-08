import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  partner: false,
  tasks: null as ReadonlyArray<{ taskId: string; state: string; brief: { goal: string } }> | null,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({
      threads: [
        {
          id: "thread-1",
          title: "Fix the login form",
          archivedAt: state.archivedAt,
          partnerBotId: state.partner ? "bot-1" : null,
          hasPendingUserInput: state.input,
          hasPendingApprovals: state.approval,
          session: state.sessionError ? { status: "error" } : null,
          latestTurn: {
            turnId: "turn-1",
            state: state.turnError ? "error" : state.completedAt ? "completed" : "running",
            completedAt: state.completedAt,
          },
        },
      ],
    }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-1" }] }),
}));
vi.mock("../bots/useDeveloperTasks", () => ({
  useDeveloperTaskList: () => state.tasks,
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    partner: false,
    tasks: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  describe("partner threads", () => {
    const task = (taskId: string, taskState: string) => ({
      taskId,
      state: taskState,
      brief: { goal: "Fix the login redirect" },
    });
    const setTasks = async (...tasks: Array<ReturnType<typeof task>>) => {
      state.tasks = tasks;
      await render();
    };

    it("alerts when a decision card leaves the partner thread waiting on the user", async () => {
      state.partner = true;
      state.focused = false;
      state.mode = "notifications";
      await render();
      // An open decision card counts as pending user input on the shell.
      state.input = true;
      await render();
      expect(state.notification).toHaveBeenCalledWith("Input needed", {
        body: "Fix the login form",
        tag: "env-1:thread-1",
        silent: true,
      });
    });

    it("alerts when a developer task completes while the window is unfocused", async () => {
      state.partner = true;
      state.focused = false;
      state.mode = "notifications";
      await setTasks(task("task-1", "running"));
      await setTasks(task("task-1", "completed"));
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).toHaveBeenCalledTimes(1);
      expect(state.notification).toHaveBeenCalledWith("Developer task completed", {
        body: "Fix the login redirect",
        tag: "env-1:thread-1",
        silent: true,
      });
    });

    it("alerts when a developer task fails", async () => {
      state.partner = true;
      state.focused = false;
      state.mode = "notifications-and-sound";
      await setTasks(task("task-1", "running"));
      await setTasks(task("task-1", "failed"));
      expect(state.notification).toHaveBeenCalledWith(
        "Developer task failed",
        expect.objectContaining({ body: "Fix the login redirect" }),
      );
      expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    });

    it.each([
      {
        event: "waiting on the user",
        title: "Input needed",
        // A parked developer plus an open decision card is what the shell reports.
        arrive: async () => {
          state.input = true;
          await setTasks(task("task-1", "waiting-on-user"));
        },
      },
      {
        event: "completed",
        title: "Developer task completed",
        arrive: () => setTasks(task("task-1", "completed")),
      },
      {
        event: "failed",
        title: "Developer task failed",
        arrive: () => setTasks(task("task-1", "failed")),
      },
    ])(
      "fires one system alert when a task is $event and the window is unfocused",
      async ({ title, arrive }) => {
        state.partner = true;
        state.focused = false;
        state.mode = "notifications";
        await setTasks(task("task-1", "running"));
        expect(state.notification).not.toHaveBeenCalled();

        await arrive();
        await render();

        expect(state.add).not.toHaveBeenCalled();
        expect(state.notification).toHaveBeenCalledTimes(1);
        expect(state.notification).toHaveBeenCalledWith(
          title,
          expect.objectContaining({ tag: "env-1:thread-1", silent: true }),
        );
      },
    );

    it("shows a toast instead while the app is focused on another thread", async () => {
      state.partner = true;
      await setTasks(task("task-1", "running"));
      await setTasks(task("task-1", "completed"));
      expect(state.add).toHaveBeenCalledTimes(1);
      expect(state.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Developer task completed",
          description: "Fix the login redirect",
        }),
      );
      expect(state.notification).not.toHaveBeenCalled();
    });

    it("stays quiet for the thread the user is already looking at", async () => {
      state.partner = true;
      state.active = { environmentId: "env-1", threadId: "thread-1" };
      await setTasks(task("task-1", "running"));
      await setTasks(task("task-1", "completed"));
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    });

    it("does not replay finished tasks on first load, or alert for a canceled one", async () => {
      state.partner = true;
      state.focused = false;
      state.mode = "notifications";
      await setTasks(task("old", "completed"), task("task-2", "running"));
      await setTasks(task("old", "completed"), task("task-2", "canceled"));
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    });

    it("does not watch threads without a partner", async () => {
      state.focused = false;
      state.mode = "notifications";
      await setTasks(task("task-1", "running"));
      await setTasks(task("task-1", "completed"));
      expect(state.notification).not.toHaveBeenCalled();
    });
  });
});
