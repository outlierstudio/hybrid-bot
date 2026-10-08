import { describe, expect, it } from "vite-plus/test";
import { isUserVisibleMessage } from "./isUserVisibleMessage.ts";

describe("isUserVisibleMessage", () => {
  it("shows ordinary user and assistant text", () => {
    expect(isUserVisibleMessage({ text: "hello", visibility: "user" })).toBe(true);
    expect(isUserVisibleMessage({ text: "hello" })).toBe(true);
  });

  it("hides internal visibility and system-wake / developer-brief origins", () => {
    expect(isUserVisibleMessage({ text: "wake", visibility: "internal" })).toBe(false);
    expect(isUserVisibleMessage({ text: "wake", origin: "system-wake" })).toBe(false);
    expect(isUserVisibleMessage({ text: "brief", origin: "developer-brief" })).toBe(false);
  });

  it("hides legacy harness-brief sentinel rows", () => {
    expect(isUserVisibleMessage({ text: '[[hybrid:harness-brief]]\n{"goal":"x"}' })).toBe(false);
  });

  it("keeps migrated partner-voice lines", () => {
    expect(isUserVisibleMessage({ text: "Created the file.", origin: "bot" })).toBe(true);
  });
});
