# Hybrid seams (probe record)

Date: 2026-09-25  
Upstream tip imported: `e5a46d6c5` (pingdotgg/t3code)  
Workspace layout: `<workspace>/{plans,app,refs}`

## Toolchain (Phase 0.2)

| Item            | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| Package manager | **pnpm@11.10.0** (`packageManager` field); scripts via `vp` (vite-plus), not bun |
| Node            | engines `^24.13.1`; probe machine may be newer (warn only)                       |
| Scripts         | `dev`, `dev:desktop`, `build`, `typecheck`/`tc`, `test`, `lint`, `fmt`           |
| License         | MIT — Copyright (c) 2026 T3 Tools Inc.                                           |
| AGENTS.md       | Present — follow kill/userdata/origin rules; do not write `~/.t3`                |

Replace all `bun` references in EXECUTION with `pnpm` / `vp run …`.

## Akeru (Phase 0.4)

- Path: `<workspace>/refs/akeru-bot`
- License: MIT (T3 Tools Inc. copyright retained; Akeru is a T3 Code fork)
- Bot model: roster-first; schemas live mainly in `packages/contracts/src/orchestration.ts` (`BotAvatar`, `BotEngine`, `BotSandbox`, `BotCreatedPayload`, personality/usage caps). Editor UX under `apps/web/src/components/roster/`.
- **Decision:** reimplement Hybrid bots in our shape; do **not** port Akeru roster/DM runtime or branding. Field inspiration only (instructions, model, runtimeMode, color/avatar). No NOTICE entries for ported files (none ported).

## Phase 1 placeholders

### TURN_START_CMD

- File: `packages/contracts/src/orchestration.ts`
- Schema: `ThreadTurnStartCommand` (`type: "thread.turn.start"`)
- Client twin: `ClientThreadTurnStartCommand`
- Also: `ThreadTurnStartRequestedPayload` for the requested event

### MSG_EVENT

- `ThreadMessageSentPayload` + projected `OrchestrationMessage`
- Add optional `botId` + `botSnapshot: { handle, name, color }` to both

### DECIDER_FILE

- `apps/server/src/orchestration/decider.ts` — `case "thread.turn.start"` (~L1390)

### PROJECTOR_FILE

- `apps/server/src/orchestration/` — projection pipeline (`Services/ProjectionPipeline.ts` + message projectors). Message rows: `projection_thread_messages`.

### PROVIDER_SEND

- `ProviderAdapter.sendTurn` / `ProviderService.sendTurn`
- Input: `ProviderSendTurnInput` in `packages/contracts/src/provider.ts`
- Params: `threadId`, `input?`, `attachments?`, `modelSelection?`, `interactionMode?`, `continuation?`
- **No** per-turn system/developer instructions field → **delivery mode (b):** prepend `<bot-instructions handle="…">…</bot-instructions>` to provider payload only; stored user message keeps original text.
- Session start does take `runtimeMode` / approval / sandbox via `ProviderSessionStartInput`.

### Provider mismatch (MVP)

- Reject with typed error: `Bot @x uses <provider>; switch thread provider first` unless thread session already matches bot provider. Record: no automatic cross-provider switch in MVP.

### MIGRATIONS_DIR

- `apps/server/src/persistence/Migrations/`
- Registered in `apps/server/src/persistence/Migrations.ts` as `[id, "Name", import]`
- Next id: **057** — after `056_ProjectionThreadMessageBot`

### RPC_DECL

- `packages/contracts/src/rpc.ts` — `WS_METHODS` + `Rpc.make(...)` + add to `WsRpcGroup`

### RPC_HANDLER

- `apps/server/src/ws.ts` — method map (~L2582 pattern)
- Auth scopes: `apps/server/src/auth/RpcAuthorization.ts`

### COMPOSER_FILE

- `apps/web/src/components/chat/ChatComposer.tsx` (+ `ComposerPromptEditorTiptap.tsx`)
- Mentions: `apps/web/src/composer-editor-mentions.ts` — **COMPOSER_TRIGGER** already uses `@` for path/file mentions; extend with a "Bots" group first.

### TIMELINE_FILE

- Chat view / message list under `apps/web/src/components/` (thread route `_chat.$environmentId.$threadId.tsx` → ChatView). Badge via `botSnapshot` on messages.

### SETTINGS_ROUTE

- `apps/web/src/routes/settings.*.tsx` — add `settings.bots.tsx` + nav entry in `settings.tsx`

### THEME_CSS

- `apps/web/src/index.css` (`--background`, `--primary`, app-theme tokens)

## Baseline status

- `pnpm install`: OK (prefer-offline / CI installs).
- `pnpm run typecheck` (contracts + server + web): OK after BotRegistry layer wiring (2026-09-25).

## MVP verification

| Gate                                                | Status | Evidence                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts `botId` / `botSnapshot` on turn + message | done   | `packages/contracts/src/bots.ts`, `orchestration.ts`, `bots.test.ts`                                                                                                                                                                                                                 |
| BotRegistry + migration 055 + seeds                 | done   | `apps/server/src/bots/*`, `055_Bots.ts`                                                                                                                                                                                                                                              |
| Bot-aware turns (snapshot + instructions prepend)   | done   | `OrchestrationEngine`, `ProviderCommandReactor`, `decider`, `projector`                                                                                                                                                                                                              |
| Summon UX (`@handle` → botId) + settings            | done   | ChatView, BotSettings, `useBots`, bots RPC                                                                                                                                                                                                                                           |
| Timeline BotBadge                                   | done   | `MessagesTimeline` + `MessagesTimeline.logic`                                                                                                                                                                                                                                        |
| Branding Hybrid                                     | done   | `branding.ts`, desktop productName, theme tokens                                                                                                                                                                                                                                     |
| Composer BotChip + `getSendContext().botId`         | done   | ChatComposer chip; ChatView prefers sendCtx.botId                                                                                                                                                                                                                                    |
| BotSettings export/import + duplicate               | done   | `BotSettings.tsx` JSON download/upload                                                                                                                                                                                                                                               |
| `~/.hybrid` + desktop `dev.hybrid.app`              | done   | DesktopStatePaths, DesktopEnvironment, os-jank, devHome                                                                                                                                                                                                                              |
| Typecheck (full monorepo)                           | done   | `vp run typecheck` exit 0 (2026-09-25)                                                                                                                                                                                                                                               |
| Lint (full monorepo)                                | done   | `vp run lint` exit 0 after Hybrid CSS/import fixes                                                                                                                                                                                                                                   |
| Build (full monorepo)                               | done   | `vp run build` exit 0 (re-verified 2026-09-25 after branding + badge persistence)                                                                                                                                                                                                    |
| Hybrid unit tests                                   | done   | bots server 7, web bots+branding 13, contracts bots 5                                                                                                                                                                                                                                |
| Desktop identity + composer menu tests              | done   | DesktopEnvironment 14/14; ComposerCommandMenu + bots 8/8                                                                                                                                                                                                                             |
| Server suite (full)                                 | mostly | 5339 passed / 51 failed; none in hybrid/bot paths (pre-existing)                                                                                                                                                                                                                     |
| Manual summon + badge checklist                     | done   | 2026-09-25 Luna (GPT-5.6-Luna): `@research` → user `→ @research` + assistant `Research` badges + reply; plain turn no badges (`plain-ok`); Settings `@docs` usable in composer with `docs` badges. Thread `ae3af2b5…`.                                                               |
| Delete `@docs` → snapshot badges persist            | done   | 2026-09-25: deleted custom `@docs` via Settings → Bots; DB `bots` no longer has `docs`; after thread reload, DOM still had `data-bot-handle=docs` (`→ @docs` + `Docs`) from `bot_snapshot_json`.                                                                                     |
| Desktop Phase 7 smoke (`vp run dev:desktop`)        | done   | 2026-09-25: `T3CODE_BUNDLED_DEV=1` (unbundled Vite hit `ERR_INSUFFICIENT_RESOURCES` in Electron). Window `Hybrid (Dev)`; embedded server `:13773`; CDP: Greeting still has research/docs/planner badges; Settings → Bots lists built-ins (no deleted `@docs`). Same renderer as web. |
| Thread cache v5 (bot fields)                        | done   | web+mobile `THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION=5` invalidates pre-botSnapshot warm caches                                                                                                                                                                                          |
| Client reducer preserves `botSnapshot`              | done   | `threadReducer.ts` + test; timeline row projection test                                                                                                                                                                                                                              |
| Typecheck re-verify (badge fix)                     | done   | `vp run typecheck` exit 0 after ComposerCommandMenu + threadReducer test fixes (2026-09-25)                                                                                                                                                                                          |
| Phase 6 leftover "T3 Code" strings                  | done   | Swept apps/web+desktop production sources → Hybrid; kept intentional legacy Electron userData dir names (`T3 Code (Dev)` / `(Alpha)`) for migration.                                                                                                                                 |
