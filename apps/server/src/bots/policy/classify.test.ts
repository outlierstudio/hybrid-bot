import { describe, expect, it } from "@effect/vitest";

import type { ApprovalClass } from "@t3tools/contracts";
import type { ProviderRequestKind } from "@t3tools/contracts";

import {
  classifyApprovalRequest,
  classifyCommandParts,
  ruleMatchKeys,
  splitShellCommand,
} from "./classify.ts";

const ROOT = "/work/repo";

type Case = {
  readonly requestKind: ProviderRequestKind | undefined;
  readonly detail: string | undefined;
  readonly expected: ApprovalClass;
};

const classify = (requestKind: ProviderRequestKind | undefined, detail: string | undefined) =>
  classifyApprovalRequest({ requestKind, detail, workspaceRoot: ROOT });

describe("classifyApprovalRequest", () => {
  const table: ReadonlyArray<Case & { readonly label?: string }> = [
    { requestKind: "file-read", detail: "src/a.ts", expected: "none" },
    { requestKind: "file-change", detail: "src/a.ts", expected: "none" },
    { requestKind: "file-read", detail: "/work/repo/package.json", expected: "none" },
    { requestKind: "file-change", detail: "./src/b.ts", expected: "none" },
    { requestKind: "file-read", detail: undefined, expected: "none" },

    { requestKind: "file-read", detail: ".env", expected: "secrets" },
    { requestKind: "file-change", detail: ".env.local", expected: "secrets" },
    { requestKind: "file-read", detail: "/work/repo/.env.production", expected: "secrets" },
    { requestKind: "file-read", detail: "~/.ssh/config", expected: "secrets" },
    { requestKind: "file-read", detail: ".aws/credentials", expected: "secrets" },
    { requestKind: "file-read", detail: "config/credentials.json", expected: "secrets" },
    {
      requestKind: "file-read",
      detail: "Library/Keychains/login.keychain-db",
      expected: "secrets",
    },

    { requestKind: "file-read", detail: "/etc/hosts", expected: "outside-workspace" },
    { requestKind: "file-change", detail: "../other/a.ts", expected: "outside-workspace" },
    { requestKind: "file-read", detail: "/work/repo-evil/a.ts", expected: "outside-workspace" },

    { requestKind: "command", detail: "pnpm test", expected: "none" },
    { requestKind: "command", detail: "vitest run", expected: "none" },
    { requestKind: "command", detail: "git status", expected: "none" },
    { requestKind: "command", detail: "rg TODO src", expected: "none" },
    { requestKind: "command", detail: "pnpm run build", expected: "none" },
    { requestKind: "command", detail: "tsc --noEmit", expected: "none" },

    { requestKind: "command", detail: "pnpm install", expected: "install" },
    { requestKind: "command", detail: "pnpm add zod", expected: "install" },
    { requestKind: "command", detail: "npm install", expected: "install" },
    { requestKind: "command", detail: "yarn add left-pad", expected: "install" },
    { requestKind: "command", detail: "bun install", expected: "install" },

    { requestKind: "command", detail: "rm -rf node_modules", expected: "delete" },
    { requestKind: "command", detail: "git clean -fd", expected: "delete" },
    { requestKind: "command", detail: "git reset --hard HEAD", expected: "delete" },

    { requestKind: "command", detail: "git push origin main", expected: "production" },
    { requestKind: "command", detail: "npm publish", expected: "production" },
    { requestKind: "command", detail: "kubectl apply -f deploy.yaml", expected: "production" },
    { requestKind: "command", detail: "terraform apply", expected: "production" },
    { requestKind: "command", detail: "gh pr merge 42", expected: "production" },

    { requestKind: "command", detail: "curl -X POST https://example.com/hook", expected: "send" },
    { requestKind: "command", detail: "curl --data foo https://example.com", expected: "send" },
    { requestKind: "command", detail: "mail user@example.com", expected: "send" },
    {
      requestKind: "command",
      detail: "curl https://hooks.slack.com/services/T/B/x",
      expected: "send",
    },

    {
      requestKind: "command",
      detail: "cat /work/repo/.env",
      expected: "secrets",
      label: "secrets beat none for in-tree env path",
    },
    {
      requestKind: "command",
      detail: "pnpm test && git push",
      expected: "production",
      label: "production beats none across &&",
    },
    {
      requestKind: "command",
      detail: "pnpm add zod && cat .env",
      expected: "secrets",
      label: "secrets beats install",
    },

    { requestKind: "mcp-elicitation", detail: "open browser", expected: "production" },
    { requestKind: "permission", detail: "network access", expected: "production" },
    { requestKind: undefined, detail: "anything", expected: "production" },
  ];

  for (const row of table) {
    const name = row.label ?? `${row.requestKind ?? "undefined"}: ${row.detail ?? "(no detail)"}`;
    it(name, () => {
      expect(classify(row.requestKind, row.detail)).toBe(row.expected);
    });
  }
});

describe("splitShellCommand", () => {
  const table: ReadonlyArray<{ readonly input: string; readonly parts: ReadonlyArray<string> }> = [
    { input: "a && b || c ; d | e", parts: ["a", "b", "c", "d", "e"] },
    { input: "a\nb", parts: ["a", "b"] },
    {
      input: `git commit -m "a && b; c | d" && git push`,
      parts: [`git commit -m "a && b; c | d"`, "git push"],
    },
    { input: `echo 'x || y'; ls`, parts: [`echo 'x || y'`, "ls"] },
    {
      input: "cat > notes.md <<'EOF'\nline && rm -rf /\nEOF\ngit add notes.md",
      parts: ["cat > notes.md <<'EOF'", "git add notes.md"],
    },
    {
      input: `git commit -m "$(cat <<'EOF'\nfix: don't && break\nEOF\n)" && git push origin master`,
      parts: [`git commit -m "$(cat <<'EOF'\n)"`, "git push origin master"],
    },
    { input: "cat <<-END\n\tbody | x\n\tEND\nls", parts: ["cat <<-END", "ls"] },
  ];
  for (const row of table) {
    it(JSON.stringify(row.input), () => {
      expect(splitShellCommand(row.input)).toEqual(row.parts);
    });
  }
});

describe("classifyCommandParts keys", () => {
  const keysOf = (detail: string) =>
    classifyCommandParts(detail, ROOT)
      .filter((part) => part.approvalClass !== "none")
      .map((part) => part.key);

  const table: ReadonlyArray<{ readonly detail: string; readonly keys: ReadonlyArray<string> }> = [
    { detail: "git push origin master", keys: ["git push origin master"] },
    { detail: "git push -u origin master", keys: ["git push origin master"] },
    { detail: "git push --force origin master", keys: ["git push --force origin master"] },
    { detail: "git push -f origin master", keys: ["git push -f origin master"] },
    {
      detail: "git push --force-with-lease=master:abc origin master",
      keys: ["git push --force-with-lease origin master"],
    },
    { detail: "git push --delete origin old", keys: ["git push --delete origin old"] },
    { detail: "git push --tags origin", keys: ["git push --tags origin"] },
    { detail: "git push", keys: ["git push"] },
    { detail: "git checkout -b feat && git push origin", keys: ["git push origin feat"] },
    { detail: "git switch feat && git push -u origin HEAD", keys: ["git push origin feat"] },
    {
      detail: `printf 'x' > a && git add -A && git commit -m "first" && git push origin master`,
      keys: ["git push origin master"],
    },
    {
      detail: "bash -lc 'pnpm add zod && git push origin main'",
      keys: ["pnpm add zod", "git push origin main"],
    },
    {
      detail: `curl -X POST -H "Authorization: x" -d '{"a":1}' https://example.com/hook`,
      keys: ["curl -X POST -H -d https://example.com/hook"],
    },
    { detail: "rm -rf dist", keys: ["rm -rf dist"] },
  ];
  for (const row of table) {
    it(row.detail, () => {
      expect(keysOf(row.detail)).toEqual(row.keys);
    });
  }

  it("classifies a chain by its riskiest part", () => {
    expect(classify("command", "git status && git push origin main && cat .env")).toBe("secrets");
    expect(classify("command", "cat <<'EOF' > a.txt\ngit push origin main\nEOF")).toBe("none");
  });
});

describe("ruleMatchKeys", () => {
  it("re-normalizes an old whole-line rule into its risky parts", () => {
    expect(
      ruleMatchKeys(`printf 'x' && git add . && git commit -m "msg" && git push origin master`),
    ).toEqual(["git push origin master"]);
  });

  it("keeps a single command or path and adds its key", () => {
    expect(ruleMatchKeys("git push origin master")).toEqual(["git push origin master"]);
    expect(ruleMatchKeys("git push -u origin master")).toEqual([
      "git push -u origin master",
      "git push origin master",
    ]);
    expect(ruleMatchKeys(".env")).toEqual([".env"]);
  });
});

describe("commit messages and prose are not paths", () => {
  const table: ReadonlyArray<{ readonly detail: string; readonly expected: ApprovalClass }> = [
    { detail: `git add . && git commit -m "read credentials from vault"`, expected: "none" },
    { detail: `git commit -m "fix .env loading"`, expected: "none" },
    { detail: `git commit --message="rotate ~/.ssh keys"`, expected: "none" },
    { detail: `git commit -am "move creds to ../shared"`, expected: "none" },
    { detail: `git commit -m 'publish docs and drop old webhook'`, expected: "none" },
    {
      detail: `gh pr create --title "Load .env safely" --body "No credentials in logs"`,
      expected: "none",
    },
    {
      detail: `git add -A && git commit -F - <<'EOF'\nread credentials from ~/.aws/credentials\nEOF`,
      expected: "none",
    },
    {
      detail: `git commit -m "$(cat <<'EOF'\nfix .env and credentials loading\nEOF\n)"`,
      expected: "none",
    },
    { detail: `echo "the credentials live in vault"`, expected: "none" },

    { detail: "cat .env", expected: "secrets" },
    { detail: "cp creds ~/.aws/credentials", expected: "secrets" },
    { detail: "git add .env", expected: "secrets" },
    { detail: `git add ".env" && git commit -m "add config"`, expected: "secrets" },
    { detail: `cat "config/credentials.json"`, expected: "secrets" },
    { detail: "printf 'X=1' >.env", expected: "secrets" },
    { detail: "git commit -F ~/.ssh/msg", expected: "secrets" },
    { detail: `cp "my notes.txt" ../elsewhere/`, expected: "outside-workspace" },
  ];
  for (const row of table) {
    it(row.detail, () => {
      expect(classify("command", row.detail)).toBe(row.expected);
    });
  }
});

describe("wrapped commands fail closed", () => {
  const table: ReadonlyArray<{ readonly detail: string; readonly expected: ApprovalClass }> = [
    // Remote: always at least production; a local path class on the remote side doesn't apply.
    { detail: `ssh host "rm -rf /srv"`, expected: "production" },
    { detail: "ssh -p 2222 deploy@host uptime", expected: "production" },
    { detail: "scp dist.tar deploy@host:/srv/", expected: "production" },
    { detail: "rsync -av dist/ host:/srv/app", expected: "production" },
    { detail: "rsync -av src/ build/", expected: "none" },
    // eval and shells run their payload.
    { detail: `eval "curl -X POST https://x.io/hook"`, expected: "send" },
    { detail: `env FOO=1 bash -c "npm publish"`, expected: "production" },
    { detail: `xargs sh -c "cat .env"`, expected: "secrets" },
    { detail: `bash -c "pnpm test && git push origin main"`, expected: "production" },
    // Inline code can't be read.
    { detail: `python -c "import os; os.remove('a')"`, expected: "opaque" },
    { detail: `python3 -c "print(1)"`, expected: "opaque" },
    { detail: `node -e "require('fs').rmSync('src')"`, expected: "opaque" },
    { detail: `node --eval="x()"`, expected: "opaque" },
    { detail: `npx -y zx -e "await $\`rm -rf x\`"`, expected: "opaque" },
    { detail: `ruby -e "File.delete('a')"`, expected: "opaque" },
    { detail: `perl -e "unlink 'a'"`, expected: "opaque" },
    { detail: `deno eval "Deno.removeSync('a')"`, expected: "opaque" },
    { detail: `bun -e "x()"`, expected: "opaque" },
    { detail: `osascript -e 'tell app "Finder" to quit'`, expected: "opaque" },
    { detail: `php -r "unlink('a');"`, expected: "opaque" },
    // Prefix wrappers are unwrapped.
    { detail: "sudo rm -rf src", expected: "delete" },
    { detail: "nohup npm publish", expected: "production" },
    { detail: "nice -n 10 rm -rf dist", expected: "delete" },
    { detail: "time git push origin main", expected: "production" },
    { detail: "watch -n 5 kubectl get pods", expected: "production" },
    { detail: "command rm a.txt", expected: "delete" },
    // Still routine.
    { detail: "env NODE_ENV=test pnpm test", expected: "none" },
    { detail: "timeout 60 pnpm test", expected: "none" },
    { detail: "python scripts/gen.py", expected: "none" },
    { detail: "node build.js", expected: "none" },
    { detail: "bash scripts/check.sh", expected: "none" },
  ];
  for (const row of table) {
    it(row.detail, () => {
      expect(classify("command", row.detail)).toBe(row.expected);
    });
  }
});
