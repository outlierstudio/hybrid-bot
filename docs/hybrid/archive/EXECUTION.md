> Archived. Current design: [AUDIT.md](../AUDIT.md).

# Hybrid — Execution

This is the plan the app follows now. The original phase checklist (fork, registry, `@handle` summon, settings form, theme) shipped and is recorded in `app/docs/seams.md`. Do not build back toward that UX. New work follows the sections below.

Workspace (do not flatten):

- `<workspace>/plans/` — PLAN.md + EXECUTION.md
- `<workspace>/app/` — the git repo
- `<workspace>/refs/akeru-bot` — reference only, do not port
- `<workspace>/refs/t3code` — upstream snapshot

After editing `plans/*`, sync the copies that ship with the repo:

```bash
cp <workspace>/plans/PLAN.md <workspace>/plans/EXECUTION.md \
  <workspace>/app/docs/hybrid/
```

Package manager is pnpm. Scripts run through `vp`. Desktop dev:

```bash
cd <workspace>/app
T3CODE_BUNDLED_DEV=1 T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9222 pnpm dev:desktop
```

Web is `http://127.0.0.1:5733`. The embedded server is `http://127.0.0.1:13773`. CDP is `http://127.0.0.1:9222`. User data is `~/.hybrid`. The server bundle is not hot-reloaded; pack `apps/server` and restart the `bin.mjs` child when server code changes.

## 1. Turn dispatch

The bot is the primary agent on the thread's selected model. `ProviderCommandReactor` wraps a bot turn with partner instructions and forces `approval-required` so the partner does not edit. When the reply contains `<harness-order>`, `BotHarnessDispatch` starts a follow-up coding turn with an internal harness brief and no `botId`. That follow-up is the subagent. The order is not a card.

`PartnerRuntime` (`apps/server/src/bots/PartnerRuntime.ts`) mediates harness asks: it answers routine ones, turns a real choice into one sentence from the bot (`[[hybrid:partner]]`), and says when the harness is done. It does not replace the partner's provider turn and it does not shell out to Grok.

- Built-ins live in `apps/server/src/bots/builtins.ts`. Partner turns use the thread model. `@engineer` is full access for the coding tool. The others are read-only unless the person asked for a change.
- `partnerDecide.ts` refuses a developer call on a plain question (also enforced in `BotHarnessDispatch`), accepts routine harness asks, and turns a real choice into one sentence.
- Snapshot on the message is `{ handle, name, color }`, so old chats still show the face after a bot is deleted.
- A turn with no bot stays the harness: Thinking and Working stay.

## 2. Hatch

Route: `/new-bot` (`apps/web/src/routes/_chat.new-bot.tsx`).

- UI matches the other chats: face, name, description, message, composer. Description starts minimized.
- The interview is a real model turn: `bots.hatchTurn` → `TextGeneration.generateHatchTurn` on the person's `defaultModelSelection` (same provider instances as other bots). `hatchPlan` is only the deterministic fallback when `HYBRID_HATCH_FALLBACK=1` (tests).
- Hatch talks in sentences. `composeHatchedBot` writes the bot when the conversation is ready.
- Do not ask the name first. Do not show research / review / plan / build.
- Save failure returns to the conversation. It does not pretend the bot was built.

## 3. Sidebar and chrome

- `Sidebar.tsx` / `SidebarChrome.tsx`: Hybrid text under the traffic lights, search beside it, New bot, Projects, Recents (open by default, key `hybrid:sidebar:recents-expanded`), then the chats.
- A chat row shows the title and up to four faces. Faces come from `usedBots` on the thread shell plus `hybrid:thread-bot-marks`. `getThreadBots` must return a stable empty list, or the sidebar loops.
- Component file is `SidebarThreadBots.tsx`. Store file is `threadBotMarkStore.ts`. Do not add a second file whose name differs only by case.
- Footer is New chat, then Settings. Updates render from Settings → General.
- Settled, Usage, and Pull requests are settings routes, not main-sidebar icons.
- `ChatHeader.tsx` keeps Add action, Open, and Commit & push mounted but hidden. The visible control is the right panel toggle. Terminal drawer toggle stays off that bar (`showTerminalControl={false}`).

## 4. Composer

- When a bot is summoned, the composer does not render `ProviderModelPicker`. Model, access, and mode belong to the bot. A thread with no bot still has the picker.
- The footer effort and access blocks stay unrendered (`false ? … : null`).
- Scrolling up from the end, past 24px, rests the bar. Reaching the end opens it. Focus does not rest it.
- The motion is `composerSlideFrames` on `[data-slot='composer-shell']`: clip plus translate, bottom edge fixed, about 380ms, `cubic-bezier(0.4, 0, 0.2, 1)`. Do not animate height. A finished height animation with `fill: both` pins the bar and the next gesture snaps.
- "Message {name}" is `[data-chat-composer-placeholder]`. `measureMessageSlide` records its offset from the bot face, relative to the face, and the placeholder uses that same duration. Measure against the face, not the viewport. The card is bottom-aligned, so a viewport delta includes the card moving and sends the words the wrong way.
- The context strip does not host the resting controls (`hostsRestingComposerControls: false`). A strip under the short bar shoves the messages when the gesture ends.
- Cancel the slide and the placeholder motion in the same layout frame as the resting or expanded layout. If those transforms outlive the layout, the words and the window land apart.

## 5. Bot presence

- Bot turns: `BotPresence` / `BotWorkingStatus`. Before reply text, "{Name} is on it.." and `partner-looking` on the eyes. While text is streaming, three `.partner-dot` marks. Both leave when streaming ends.
- The live row exists only until this turn's assistant text exists. Count text after the latest user message. Older replies in the thread do not count.
- While a bot owns the turn (user message has a bot snapshot), tool rows, activity groups, and diffs stay private. A partner-owned harness span (from `[[hybrid:harness-brief]]` until the next partner line) is also omitted: no Thinking, Working, harness assistant text, or order card.
- Harness turns with no bot keep Thinking and Working.
- Pending approvals and questions are not shown when `partnerOwnsHarnessAsks` is true. The bot asks in a sentence.

## 6. Checks

Web tests:

```bash
cd <workspace>/app/apps/web
vp test run src/bots/hatchBot.test.ts
vp test run src/components/chat/MessagesTimeline.logic.test.ts
```

Typecheck from `apps/web` or `apps/server` with `tsc --noEmit` via that package's local binary. `pnpm exec` from the git root at `<workspace>` is the wrong workspace.

Accept for a composer or presence change, in the running Electron window:

- Scroll up from the bottom: the window, the face, the name, and "Message {name}" move together. The bottom edge does not jump. The words are on the short row when the gesture ends.
- Scroll back to the end: the bar opens the same way, and "Message {name}" returns under the name with the window.
- A bot reply shows "is on it..", then dots, then the reply, with no Thinking.
- A harness reply still shows Thinking and Working.

## 7. Do not start

A second inbox, an Akeru port, Dr. Eggbot, hardcoded Hatch types, height tweens on the composer, Thinking on bot turns, showing the harness to the person, or putting Settled, Usage, Pull requests, and updates back on the main sidebar.
