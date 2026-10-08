import { describe, expect, it } from "vite-plus/test";

import { HYBRID_ENGINE_DRIVERS, isHybridEngineDriver } from "./bots.ts";

describe("Hybrid engine drivers", () => {
  it("Developer directly off: only Claude and Codex", () => {
    expect([...HYBRID_ENGINE_DRIVERS].toSorted()).toEqual(["claudeAgent", "codex"]);
    for (const driver of ["claudeAgent", "codex"]) expect(isHybridEngineDriver(driver)).toBe(true);
    for (const driver of ["cursor", "grok", "opencode", "antigravity"]) {
      expect(isHybridEngineDriver(driver, false)).toBe(false);
    }
  });

  it("Developer directly on: any driver", () => {
    expect(isHybridEngineDriver("cursor", true)).toBe(true);
  });
});
