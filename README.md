# Hybrid

Hybrid is a fork of [T3 Code](https://github.com/pingdotgg/t3code): a minimal GUI for coding agents (Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity) with web, desktop, and mobile clients.

Hybrid adds a **partner / developer** model. You talk to one associate, **Hybrid**, in plain language. It reads the code to answer questions, reviews a diff when you ask, proposes a plan for larger work, and drives a hidden developer task on the same worktree for changes. It keeps you updated and only surfaces a decision card when something needs your call. Each work card's Show work and Show diff open the developer's raw transcript and changes.

There are no custom bots yet: Hybrid is the only associate.

Userdata lives under `~/.hybrid` (worktrees: `<worktree>/.hybrid`). See `NOTICE.md`.

## Run from source

```bash
# Install the Vite+ CLI once: https://viteplus.dev/guide/
vp i
vp run dev
```

Pair with the URL printed on server startup, then use the local web UI. Install and authenticate at least one provider CLI on `PATH` before expecting an agent to run.

## Known limitations

Deferred past this version (see [docs/hybrid/AUDIT.md](docs/hybrid/AUDIT.md), Status):

- No bot memory yet.
- Hybrid works with Claude and Codex subscriptions: its own and its developer's engines run on Claude Code or Codex only.
- Custom bots are disabled in this version, and there are no specialists to consult. You always talk to Hybrid; old threads from before Hybrid open read-only until you continue them with Hybrid.
- The free-text rules reviewer is built but off by default.
- Mobile has no work or decision cards.
- No upstream-drift check yet.
- The composer motion hasn't been revisited.
- The live conversation checklist hasn't been run on a real model yet. Not verified live: mid-task steer, failing tests reported honestly, continuing an old thread with Hybrid, mobile, non-English requests.

## Credits

Hybrid is built on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., the upstream
project, under its MIT license (see `LICENSE` and `NOTICE.md`).
