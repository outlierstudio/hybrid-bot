import { describe, expect, it } from "vite-plus/test";

import { parseEvalPartnerCli, parseEvalPartnerProvider } from "./evalPartnerCli.ts";

describe("parseEvalPartnerProvider", () => {
  it("defaults to codex and accepts claude", () => {
    expect(parseEvalPartnerProvider(undefined)).toBe("codex");
    expect(parseEvalPartnerProvider("Claude")).toBe("claude");
    expect(parseEvalPartnerProvider("codex")).toBe("codex");
  });

  it("rejects unknown providers", () => {
    expect(() => parseEvalPartnerProvider("openai")).toThrow(/Unknown --provider/);
  });
});

describe("parseEvalPartnerCli", () => {
  it("requires --model", () => {
    expect(() => parseEvalPartnerCli({ provider: "claude" })).toThrow(/--model/);
  });

  it("parses provider, model, and effort together", () => {
    expect(
      parseEvalPartnerCli({
        provider: "claude",
        model: "claude-sonnet-5-5",
        effort: "LOW",
        only: "q-usebots",
        strict: true,
      }),
    ).toEqual({
      provider: "claude",
      model: "claude-sonnet-5-5",
      effort: "low",
      out: undefined,
      only: "q-usebots",
      strict: true,
    });
  });
});
