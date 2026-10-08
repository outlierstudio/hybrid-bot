import { describe, expect, it } from "vite-plus/test";

import { isMutatingShellCommand, partnerReadOnlyDenial } from "./partnerReadOnly.ts";

describe("partnerReadOnlyDenial", () => {
  it.each(["Edit", "MultiEdit", "Write", "NotebookEdit"])("denies %s", (tool) => {
    expect(partnerReadOnlyDenial(tool, { file_path: "/x" })).toEqual(
      expect.stringContaining("read-only"),
    );
  });

  it.each(["Read", "Grep", "Glob", "WebFetch"])("allows %s", (tool) => {
    expect(partnerReadOnlyDenial(tool, {})).toBeNull();
  });

  it("allows read-only Bash and denies mutating Bash", () => {
    expect(partnerReadOnlyDenial("Bash", { command: "rg foo src | head -5" })).toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "git status && git diff" })).toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "git status" })).toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "rg foo src" })).toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "touch x" })).not.toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "sed -i s/a/b/ f" })).not.toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "rm -rf dist" })).not.toBeNull();
    expect(partnerReadOnlyDenial("Bash", { command: "echo hi > file.txt" })).not.toBeNull();
    expect(partnerReadOnlyDenial("Bash", {})).not.toBeNull();
  });
});

describe("isMutatingShellCommand", () => {
  it.each([
    "git commit -m x",
    "git checkout main",
    "npm install",
    "cat a | tee b",
    "ls; rm a",
    "find . -name x -delete",
    "find . -exec rm {} ;",
    "echo $(rm a)",
    "sed -i s/a/b/ f",
    "sort -o out in",
    "cat a &",
  ])("treats %s as mutating", (command) => {
    expect(isMutatingShellCommand(command)).toBe(true);
  });

  it.each(["ls -la", "cat README.md", "git log --oneline -5", "rg -n foo . | wc -l", "pwd"])(
    "treats %s as read-only",
    (command) => {
      expect(isMutatingShellCommand(command)).toBe(false);
    },
  );
});
