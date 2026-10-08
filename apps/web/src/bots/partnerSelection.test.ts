import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_BOT_IDS, HYBRID_BOT_ID } from "@t3tools/contracts";
import { projectDefaultPartnerBotId } from "./partnerSelection";

describe("projectDefaultPartnerBotId", () => {
  it("multi-bot on: uses the project default when set, else Hybrid", () => {
    expect(projectDefaultPartnerBotId(BUILTIN_BOT_IDS.research, true)).toBe(
      BUILTIN_BOT_IDS.research,
    );
    expect(projectDefaultPartnerBotId(null, true)).toBe(HYBRID_BOT_ID);
    expect(projectDefaultPartnerBotId(undefined, true)).toBe(HYBRID_BOT_ID);
  });

  it("multi-bot off: every new thread starts with Hybrid", () => {
    expect(projectDefaultPartnerBotId(BUILTIN_BOT_IDS.research, false)).toBe(HYBRID_BOT_ID);
    expect(projectDefaultPartnerBotId(null, false)).toBe(HYBRID_BOT_ID);
    // The shipped default.
    expect(projectDefaultPartnerBotId(BUILTIN_BOT_IDS.planner)).toBe(HYBRID_BOT_ID);
  });
});
