import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { latestAssistantMessageRowId } from "../components/chat/MessagesTimeline.logic";
import {
  PartnerPresenceContext,
  PresenceBubble,
  shouldShowTimelinePresence,
  TimelinePresenceBubble,
} from "./PresenceBubble";

describe("presence pill", () => {
  it("shows on the empty state with the live text, Ready included", () => {
    const html = renderToStaticMarkup(
      <PresenceBubble presence={{ kind: "ready", text: "Ready" }} />,
    );
    expect(html).toContain("Ready");
    expect(html).toContain("presence-bubble");
  });

  it("in the timeline, hides while idle and shows while working or waiting", () => {
    expect(shouldShowTimelinePresence(null)).toBe(false);
    expect(shouldShowTimelinePresence({ kind: "ready", text: "Ready" })).toBe(false);
    expect(shouldShowTimelinePresence({ kind: "working", text: "Reading app/page.tsx" })).toBe(
      true,
    );
    expect(shouldShowTimelinePresence({ kind: "waiting", text: "Waiting for you" })).toBe(true);

    const idle = renderToStaticMarkup(
      <PartnerPresenceContext value={{ kind: "ready", text: "Ready" }}>
        <TimelinePresenceBubble />
      </PartnerPresenceContext>,
    );
    expect(idle).toBe("");
    const working = renderToStaticMarkup(
      <PartnerPresenceContext value={{ kind: "working", text: "Reading app/page.tsx" }}>
        <TimelinePresenceBubble />
      </PartnerPresenceContext>,
    );
    expect(working).toContain("Reading app/page.tsx");
  });

  it("rides on Hybrid's newest assistant message", () => {
    expect(
      latestAssistantMessageRowId([
        { kind: "message", id: "u1", message: { role: "user" } },
        { kind: "message", id: "a1", message: { role: "assistant" } },
        { kind: "work", id: "w1" },
        { kind: "message", id: "a2", message: { role: "assistant" } },
        { kind: "message", id: "u2", message: { role: "user" } },
      ]),
    ).toBe("a2");
    expect(
      latestAssistantMessageRowId([{ kind: "message", id: "u1", message: { role: "user" } }]),
    ).toBeNull();
  });
});
