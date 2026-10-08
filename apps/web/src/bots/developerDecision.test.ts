import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import { deriveWorkLogEntries } from "../session-logic";
import { derivePendingPartnerDecisions } from "./developerDecision";

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id,
    kind,
    tone: "info",
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  }) as unknown as OrchestrationThreadActivity;

const card = (cardId: string, extra: Record<string, unknown> = {}) =>
  activity(`activity-${cardId}`, "partner-decision", {
    cardId,
    parentThreadId: "thread-1",
    botId: "bot-1",
    kind: "approval",
    question: "Push to main?",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  });

const resolved = (cardId: string) =>
  activity(`resolved-${cardId}`, "partner-decision.resolved", { cardId, decision: "accept" });

describe("derivePendingPartnerDecisions", () => {
  it("maps the card payload", () => {
    expect(
      derivePendingPartnerDecisions([
        card("c1", {
          approvalClass: "production",
          taskId: "task-1",
          requestId: "req-1",
          alwaysAllow: [
            { approvalClass: "production", matchDetail: "git push origin master" },
            { approvalClass: "production", matchDetail: "ssh deploy@host 'systemctl restart app'" },
            { approvalClass: "opaque", matchDetail: "python -c 'import os'" },
            { matchDetail: 7 },
          ],
        }),
        card("c2", { kind: "question", question: "Which one?", options: ["web", 3, "server"] }),
      ]),
    ).toEqual([
      {
        cardId: "c1",
        kind: "approval",
        question: "Push to main?",
        options: [],
        approvalClass: "production",
        alwaysAllow: [
          { key: "git push origin master", kind: null },
          { key: "ssh deploy@host 'systemctl restart app'", kind: "remote" },
          { key: "python -c 'import os'", kind: "inline" },
        ],
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        cardId: "c2",
        kind: "question",
        question: "Which one?",
        options: ["web", "server"],
        approvalClass: null,
        alwaysAllow: [],
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops a card once it is resolved", () => {
    expect(
      derivePendingPartnerDecisions([card("c1"), card("c2"), resolved("c1")]).map(
        (entry) => entry.cardId,
      ),
    ).toEqual(["c2"]);
  });

  it("ignores malformed payloads and unknown classes", () => {
    expect(
      derivePendingPartnerDecisions([
        activity("bad", "partner-decision", {}),
        card("c1", { kind: "other" }),
      ]),
    ).toEqual([]);
    expect(
      derivePendingPartnerDecisions([card("c1", { approvalClass: "weird" })])[0],
    ).toMatchObject({ approvalClass: null });
  });

  it("keeps decision activities out of the work log", () => {
    expect(deriveWorkLogEntries([card("c1"), resolved("c1")])).toEqual([]);
  });
});

describe("decision card timeline row", () => {
  it("renders one inline row per pending decision", () => {
    const partnerDecisions = derivePendingPartnerDecisions([card("c1")]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      partnerDecisions,
    });
    expect(rows).toEqual([
      {
        kind: "partner-decision",
        id: "partner-decision:c1",
        createdAt: "2026-08-01T00:00:00.000Z",
        decision: partnerDecisions[0],
      },
    ]);
  });
});
