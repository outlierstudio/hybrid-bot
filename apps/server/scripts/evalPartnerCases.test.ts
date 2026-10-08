import { describe, expect, it } from "vite-plus/test";

import { partnerEvalCases } from "./evalPartnerCases.ts";

describe("partnerEvalCases", () => {
  it("keeps Spanish change request pointed at a file that exists in the fixture", () => {
    const fixture = partnerEvalCases.find((entry) => entry.id === "es-fix-button");
    expect(fixture).toBeDefined();
    const text = fixture!.messages.map((message) => message.text).join("\n");
    expect(text).toContain("CookieBanner.tsx");
    expect(text.toLowerCase()).not.toContain("botón de registro");
  });

  it("asks change-short-fix for a concrete developer handoff", () => {
    const fixture = partnerEvalCases.find((entry) => entry.id === "change-short-fix");
    expect(fixture).toBeDefined();
    const text = fixture!.messages.map((message) => message.text).join("\n");
    expect(text).toContain("SidebarSearch.test.tsx");
    expect(text.toLowerCase()).toContain("developer");
  });

  it("has one scenario per Situation rule in the partner prompt", () => {
    const ids = partnerEvalCases.map((entry) => entry.id);
    for (const id of [
      "situation-bug-report",
      "situation-vague-request",
      "situation-status-check",
      "situation-tests-failed",
      "situation-frustrated",
      "situation-other-language",
      "situation-review",
      "situation-why-how",
      "situation-question",
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
