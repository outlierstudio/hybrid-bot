/**
 * // HYBRID: parse leading @handle bot mentions from composer text.
 */
export type ParseBotMentionResult =
  | { readonly kind: "none"; readonly text: string }
  | {
      readonly kind: "mention";
      readonly botHandle: string;
      readonly text: string;
    }
  | {
      readonly kind: "trigger";
      readonly query: string;
    };

const HANDLE = /^@([a-z][a-z0-9-]{1,31})(?:\s+|$)([\s\S]*)$/;
const TRIGGER = /^@([a-z0-9-]*)$/;

/**
 * MVP: only a leading `@handle` (first token) counts as a summon.
 * Mid-sentence `@x` and emails are ignored.
 */
export function parseBotMention(raw: string): ParseBotMentionResult {
  const text = raw;
  const trimmedStart = text.replace(/^\s+/, "");
  if (!trimmedStart.startsWith("@")) {
    return { kind: "none", text };
  }

  // Autocomplete trigger: caret-equivalent when the whole draft is just `@query`
  const trigger = TRIGGER.exec(trimmedStart);
  if (trigger && !/\s/.test(trimmedStart.slice(1))) {
    return { kind: "trigger", query: trigger[1] ?? "" };
  }

  const match = HANDLE.exec(trimmedStart);
  if (!match) {
    return { kind: "none", text };
  }

  const handle = match[1]!;
  const rest = (match[2] ?? "").replace(/^\s+/, "");
  // email-like: @ already not at start handled above; reject handles with dots via pattern
  return { kind: "mention", botHandle: handle, text: rest };
}
