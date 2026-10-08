/**
 * HYBRID: Domain-event fixtures for partner approval tests.
 */
import { EventId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";

export const PARTNER_FLOW_THREAD_ID = ThreadId.make("thread-partner-flow");
export const PARTNER_FLOW_TURN_ID = TurnId.make("turn-partner-flow");

export function approvalRequested(input: {
  readonly sequence: number;
  readonly requestId: string;
  readonly detail: string;
}): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    sequence: input.sequence,
    eventId: EventId.make(`evt-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: PARTNER_FLOW_THREAD_ID,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: PARTNER_FLOW_THREAD_ID,
      activity: {
        id: EventId.make(`act-${input.sequence}`),
        tone: "info",
        kind: "approval.requested",
        summary: "Approval required",
        payload: { requestId: input.requestId, detail: input.detail },
        turnId: PARTNER_FLOW_TURN_ID,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  } as OrchestrationEvent;
}
