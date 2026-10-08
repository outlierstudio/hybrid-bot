/**
 * HYBRID: whether a message should appear in user-facing timelines.
 *
 * Typed `visibility: "internal"` hides wake-ups and other server-only rows.
 * Migration 061 rewrote legacy `[[hybrid:harness-brief]]` rows to typed
 * fields; the sentinel check below is a read-time fallback for projections
 * rebuilt from old events.
 */
import type { MessageOrigin, MessageVisibility } from "@t3tools/contracts";

const LEGACY_HARNESS_BRIEF_SENTINEL = "[[hybrid:harness-brief]]";

export type UserVisibleMessageInput = {
  readonly visibility?: MessageVisibility | null | undefined;
  readonly text?: string | null | undefined;
  readonly origin?: MessageOrigin | string | null | undefined;
};

export function isUserVisibleMessage(message: UserVisibleMessageInput): boolean {
  if (message.visibility === "internal") return false;
  if (message.origin === "system-wake") return false;
  if (message.origin === "developer-brief") return false;
  const text = message.text ?? "";
  if (text.startsWith(LEGACY_HARNESS_BRIEF_SENTINEL)) return false;
  return true;
}
