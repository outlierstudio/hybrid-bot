> Archived. Current design: [AUDIT.md](../AUDIT.md).

# Hybrid — Plan

## 1. What we're building

Hybrid is a fork of **T3 Code**. The spine is still the coding-agent harness: projects, threads, diffs, checkpoints, approvals. On top of that is a partner the person actually talks to.

The person should not drive the harness. They talk to a bot. The bot researches, explains, and listens. When the project should change, the bot briefs a developer and the harness does the edit. One thread holds both: the partner's replies and the developer's work.

A **bot** is a named partner: handle, name, face color, instructions, provider, model, and whether it may send a developer. Built-ins are `@engineer`, `@research`, `@reviewer`, and `@planner`. People make their own with **Hatch**.

Differentiator: Akeru is roster-first (pick a bot, DM it). Hybrid is a conversation. The thread belongs to the project. The bot is who you are talking to. The harness is who steps in when code should change.

## 2. How a turn works

The bot is the primary agent. It talks to the person on the model they already picked. The coding harness is a subagent that bot calls when the project should change — not a second voice and not a second inbox.

The person addresses the bot. The bot speaks in the thread. When the project should change, the bot keeps the order internal and starts a harness turn in the same thread. Thinking, Working, tool rows, diffs, approvals, and harness questions stay private context for the bot. The bot says what matters, then says when it is done.

The bot answers a routine harness ask from what the person already said. It asks the person only when the choice is theirs, as a sentence, never as an approval shield. A plain question does not start a developer turn.

Built-ins use the thread's selected provider for the partner turn. The coding tool follows the bot's runtime mode (`@engineer` full access; the others read-only unless the person asked for a change). Model, access, and mode stay off the person's bar while a bot is selected. The bot owns them.

Plain turns with no bot stay the original harness: Thinking, Working, approvals, diffs.

## 3. Hatch

New bots are created by talking to Hatch, not by filling a settings form first.

Hatch is an eggbot-like creator. It is not Lauren Tan's Dr. Eggbot, and it is not a port of Akeru. The interview is a real conversation on the model the person already picked (`bots.hatchTurn` → TextGeneration). It is not a name-first script and it does not offer type chips. `hatchPlan` exists only as a deterministic test fallback.

Rules:

- Do not ask for a name first.
- Read what the person wants from the sentence they typed.
- Ask one contextual question, or confirm when the sentence is already enough.
- Do not offer hardcoded research / review / plan / build chips.
- Recommend a name only after the job is clear. The person can type their own.
- A named listener confirms in a sentence, then Hatch writes the bot.
- If it is unclear whether the bot should change the project, Hatch asks that in one sentence.

The hatched bot is Codex, read-only unless it sends a developer, and its instructions tell it not to do the harness's job itself.

## 4. The screen

The app should feel like talking to someone, not like an IDE. Chrome stays out of the way. The agent does the work from the chat.

**Sidebar**

- Header is a plain black drag strip. "Hybrid" sits under the window controls, as text. A search icon sits next to it.
- Under that: full-width New bot, then full-width Projects.
- Recents is open by default and can minimize. Each chat is a title plus the faces of bots used in that chat, up to four. Faces update when a bot is used.
- Bottom: New chat on the left, Settings on the right.
- Check for updates, Settled, Usage, and Pull requests are not on this sidebar. Updates are in Settings → General. The others are settings pages.

**Chat chrome**

- The top bar keeps only the right-side panel toggle (browser, terminal, and the rest).
- New chat greets with the bot's line minimized. The same minimize control exists for every bot, including Hatch.
- More than four bots: faces only, no names.

**Composer**

- Model, access, and mode are not on the person's bar while a bot is the addressee. The bot owns them.
- Effort and access chips do not sit on the bar.
- Scrolling up from the bottom of a thread shrinks the bar into one short row. The bottom edge stays put. The glass window, the bot face, the bot name, and the "Message {name}" line all move in the same gesture. Scrolling back to the end opens the bar the same way.
- Do not animate the bar's layout height. That fights the message list. The window is a clip and a transform on the composer shell. "Message {name}" slides relative to the bot face so it lands in the row with the window, not after it.

**While a bot is talking**

- Before any reply text: "{Name} is on it.." and the eyes move.
- While the reply is coming out: three typing dots, then they leave when the reply is done.
- No Thinking and no Working on a bot turn.
- A harness turn with no bot keeps Thinking and Working.

## 5. What stays out

- A second inbox, roster, or DM thread. The partner's conversation is not a second place to read.
- Copying Akeru source, Akeru branding, or Dr. Eggbot.
- Making the person operate the harness UI to get code changed.
- Hardcoded Hatch type chips.
- Per-bot MCP enforcement, bot memory, marketplaces, and scheduled bots. Those are still later.

## 6. Risks

| Risk                                                          | What we do                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Height animation on the composer restutters the messages      | Move the shell with transform and clip. Hold the bottom edge. Do not tween height.                            |
| The glass window and the words inside it are different layers | Animate the shell, which paints the window. Slide "Message {name}" against the bot face in the same duration. |
| Bot presence reads as agent chrome                            | One sentence, then typing dots. Drop both when the reply is done. Leave harness Thinking alone.               |
| Hatch feels scripted                                          | Hatch is a conversation (`bots.hatchTurn`). It does not ask the name first and it does not offer type chips.  |
| Upstream T3 moves                                             | Hybrid behavior stays in `bots/` plus small marked hooks.                                                     |
