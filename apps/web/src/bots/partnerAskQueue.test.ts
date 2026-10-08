import { describe, expect, it } from "vite-plus/test";
import {
  decidePartnerAskReply,
  isComposerQueueBlockedByPendingAsk,
  PARTNER_ASK_AMBIGUOUS_HINT,
  shouldBypassRunningEnqueueForPartnerAsk,
} from "./partnerAskQueue.ts";

describe("partnerAskQueue", () => {
  it("reproduces the deadlock: hidden pending asks block the queue when partnerOwnsAsks is ignored", () => {
    const naiveBlock = /* activePendingApproval */ true || /* pendingUserInputs */ false;
    expect(naiveBlock).toBe(true);
    expect(
      isComposerQueueBlockedByPendingAsk({
        partnerOwnsAsks: true,
        hasPendingApproval: true,
        hasPendingUserInput: false,
      }),
    ).toBe(false);
  });

  it("still blocks the queue for visible harness asks", () => {
    expect(
      isComposerQueueBlockedByPendingAsk({
        partnerOwnsAsks: false,
        hasPendingApproval: true,
        hasPendingUserInput: false,
      }),
    ).toBe(true);
    expect(
      isComposerQueueBlockedByPendingAsk({
        partnerOwnsAsks: false,
        hasPendingApproval: false,
        hasPendingUserInput: true,
      }),
    ).toBe(true);
  });

  it("bypasses running-turn enqueue when the partner owns a pending ask", () => {
    expect(
      shouldBypassRunningEnqueueForPartnerAsk({
        partnerOwnsAsks: true,
        hasPendingApproval: true,
        hasPendingUserInput: false,
        phase: "running",
      }),
    ).toBe(true);
    expect(
      shouldBypassRunningEnqueueForPartnerAsk({
        partnerOwnsAsks: true,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        phase: "running",
      }),
    ).toBe(false);
    expect(
      shouldBypassRunningEnqueueForPartnerAsk({
        partnerOwnsAsks: false,
        hasPendingApproval: true,
        hasPendingUserInput: false,
        phase: "running",
      }),
    ).toBe(false);
  });

  it("maps approval replies to accept, decline, or ambiguous", () => {
    expect(decidePartnerAskReply("yes, do it")).toBe("accept");
    expect(decidePartnerAskReply("go ahead")).toBe("accept");
    expect(decidePartnerAskReply("nope")).toBe("decline");
    expect(decidePartnerAskReply("wait, why does it need to push?")).toBe("ambiguous");
  });

  it("exposes a clear hint for ambiguous approval replies", () => {
    expect(decidePartnerAskReply("wait, why?")).toBe("ambiguous");
    expect(PARTNER_ASK_AMBIGUOUS_HINT).toBe("Reply yes to approve or no to stop this step.");
  });
});
