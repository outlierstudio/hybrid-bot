// @effect-diagnostics nodeBuiltinImport:off -- reads index.css to check animation rules.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { latestTurnHeaderRowId } from "../components/chat/MessagesTimeline.logic";
import {
  TURN_HEADER_ELEMENT,
  TURN_HEADER_HEIGHT_CLASS,
  turnHeaderModel,
  type TurnHeaderPhase,
} from "./HybridTurnHeader";
import { PresenceBubble } from "./PresenceBubble";

const working = { kind: "working", text: "Reading app/page.tsx" } as const;
const waiting = { kind: "waiting", text: "Waiting for you" } as const;
const ready = { kind: "ready", text: "Ready" } as const;

describe("Hybrid turn header across one turn", () => {
  const phases: ReadonlyArray<TurnHeaderPhase> = ["thinking", "streaming", "completed"];

  it("is the same element with the same reserved height from thinking to completed", () => {
    const models = phases.map((phase) =>
      turnHeaderModel({ phase, isLatest: true, presence: ready }),
    );
    for (const model of models) {
      expect(model.element).toBe(TURN_HEADER_ELEMENT);
      expect(model.heightClass).toBe(TURN_HEADER_HEIGHT_CLASS);
    }
    // The status changes in place; when the turn ends the slot is kept, just empty.
    expect(models.map((model) => model.status)).toEqual(["Thinking…", "Writing…", ""]);
  });

  it("pops only when the turn first appears, never on the handoff or after", () => {
    expect(
      phases.map((phase) => turnHeaderModel({ phase, isLatest: true, presence: null }).pop),
    ).toEqual([true, false, false]);
  });

  it("developer work keeps speaking on the latest header; older headers stay quiet", () => {
    expect(turnHeaderModel({ phase: "completed", isLatest: true, presence: working }).status).toBe(
      "Reading app/page.tsx",
    );
    expect(turnHeaderModel({ phase: "completed", isLatest: false, presence: working }).status).toBe(
      "",
    );
  });

  it("hops the face only when a card needs the user", () => {
    expect(
      turnHeaderModel({ phase: "streaming", isLatest: true, presence: working }).attention,
    ).toBe(false);
    expect(
      turnHeaderModel({ phase: "completed", isLatest: true, presence: waiting }).attention,
    ).toBe(true);
    expect(
      turnHeaderModel({ phase: "completed", isLatest: false, presence: waiting }).attention,
    ).toBe(false);
  });

  it("the latest header is the thinking row, else the newest assistant row that opens a turn", () => {
    const snap = { handle: "hybrid" };
    expect(
      latestTurnHeaderRowId([
        {
          kind: "message",
          id: "a1",
          botSnapshot: snap,
          showBotIdentity: true,
          message: { role: "assistant" },
        },
        { kind: "message", id: "u1", message: { role: "user" } },
        { kind: "thinking", id: "live", botSnapshot: snap },
      ]),
    ).toBe("live");
    expect(
      latestTurnHeaderRowId([
        {
          kind: "message",
          id: "a1",
          botSnapshot: snap,
          showBotIdentity: true,
          message: { role: "assistant" },
        },
        {
          kind: "message",
          id: "a2",
          botSnapshot: snap,
          showBotIdentity: false,
          message: { role: "assistant" },
        },
      ]),
    ).toBe("a1");
  });
});

describe("animations on partner threads", () => {
  it("none of Hybrid's motion classes loop forever", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    for (const selector of [
      ".hybrid-turn-pop",
      ".hybrid-turn-status",
      ".presence-bubble",
      ".partner-gaze",
      ".partner-blink",
      ".partner-hop",
      ".partner-dot",
      ".partner-looking .partner-eyes",
      ".partner-project",
    ]) {
      const start = css.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf("}", start));
      expect(rule, selector).not.toContain("infinite");
    }
  });
});

describe("empty-state presence pill", () => {
  it("shows the live text, Ready included", () => {
    const html = renderToStaticMarkup(<PresenceBubble presence={ready} />);
    expect(html).toContain("Ready");
    expect(html).toContain("presence-bubble");
  });
});
