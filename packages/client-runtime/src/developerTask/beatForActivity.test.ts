import { describe, expect, it } from "vite-plus/test";

import { beatForActivity, type BeatActivity } from "./beatForActivity.ts";

const ROOT = "/work/hybrid/app";

const cases: ReadonlyArray<{
  readonly name: string;
  readonly activity: BeatActivity;
  readonly root?: string | undefined;
  readonly expected: string | null;
}> = [
  {
    name: "read single file",
    activity: {
      kind: "tool",
      itemType: "dynamic_tool_call",
      title: "Read file",
      paths: [`${ROOT}/src/auth/session.ts`],
      status: "inProgress",
    },
    expected: "Reading `src/auth/session.ts`",
  },
  {
    name: "grep many files",
    activity: {
      kind: "tool",
      title: "Grep",
      paths: ["a.ts", "b.ts", "c.ts"],
      status: "inProgress",
    },
    expected: "Looking through 3 files",
  },
  {
    name: "edit single file",
    activity: {
      kind: "tool",
      itemType: "file_change",
      paths: [`${ROOT}/src/components/CookieBanner.tsx`],
      status: "inProgress",
    },
    expected: "Editing `src/components/CookieBanner.tsx`",
  },
  {
    name: "edit many files",
    activity: {
      kind: "tool",
      itemType: "file_change",
      title: "apply_patch",
      paths: ["a.ts", "b.ts", "c.ts"],
      status: "inProgress",
    },
    expected: "Editing 3 files",
  },
  {
    name: "vitest",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pnpm exec vitest run src/foo.test.ts",
      status: "inProgress",
    },
    expected: "Running tests",
  },
  {
    name: "jest",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "npx jest --watchAll=false",
      status: "inProgress",
    },
    expected: "Running tests",
  },
  {
    name: "pytest",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pytest tests/",
      status: "inProgress",
    },
    expected: "Running tests",
  },
  {
    name: "cargo test",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "cargo test --workspace",
      status: "inProgress",
    },
    expected: "Running tests",
  },
  {
    name: "tsc",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pnpm exec tsc --noEmit",
      status: "inProgress",
    },
    expected: "Checking types",
  },
  {
    name: "lint",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pnpm lint",
      status: "inProgress",
    },
    expected: "Checking types",
  },
  {
    name: "build",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pnpm run build",
      status: "inProgress",
    },
    expected: "Building",
  },
  {
    name: "install",
    activity: {
      kind: "tool",
      itemType: "command_execution",
      command: "pnpm add lodash",
      status: "inProgress",
    },
    expected: "Installing a dependency",
  },
  {
    name: "approval pending",
    activity: { kind: "pending", pending: "approval" },
    expected: "Waiting on your OK",
  },
  {
    name: "question pending",
    activity: { kind: "pending", pending: "question" },
    expected: "Waiting on your answer",
  },
  {
    name: "idle under 60s",
    activity: { kind: "idle", idleMs: 45_000 },
    expected: null,
  },
  {
    name: "idle over 60s",
    activity: { kind: "idle", idleMs: 125_000 },
    expected: "Still working (2m)",
  },
  {
    name: "completed tool clears beat",
    activity: {
      kind: "tool",
      itemType: "file_change",
      paths: ["a.ts"],
      status: "completed",
    },
    expected: null,
  },
];

describe("beatForActivity", () => {
  it.each(cases)("$name", ({ activity, root, expected }) => {
    expect(beatForActivity(activity, root ?? ROOT)).toBe(expected);
  });
});
