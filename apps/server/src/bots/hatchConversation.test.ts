import { describe, expect, it } from "vite-plus/test";
import {
  buildHatchConversationPrompt,
  hatchResultFromGeneration,
  hatchSystemPrompt,
  parseHatchDecision,
} from "./hatchConversation.ts";

describe("hatchConversation", () => {
  it("builds a prompt that forbids name-first and type chips", () => {
    const prompt = buildHatchConversationPrompt([{ role: "user", text: "a bot that listens" }]);
    expect(prompt).toContain("Do not ask for a name first");
    expect(prompt).toContain("Do not offer research, review, plan, or build");
    expect(prompt).toContain("Person: a bot that listens");
  });

  it("maps a ready model reply into a bot spec", () => {
    expect(
      hatchResultFromGeneration({
        say: "building smartie.",
        ready: true,
        name: "Smartie",
        job: "listens and follows up",
        purpose: "Listens and follows up.",
        instructions: "You listen first, then follow up.",
        tone: 30,
        sendsDeveloper: false,
        limits: "",
      }),
    ).toEqual({
      say: "building smartie.",
      spec: {
        name: "Smartie",
        job: "listens and follows up",
        sendsDeveloper: false,
        limits: "",
        purpose: "Listens and follows up.",
        instructions: "You listen first, then follow up.",
        tone: 30,
      },
    });
  });

  it("fills the structured draft defaults and clamps tone", () => {
    const result = hatchResultFromGeneration({
      say: "ok",
      ready: true,
      name: "Scout",
      purpose: "Reads the code.",
      tone: 400,
    });
    expect(result?.spec).toMatchObject({
      name: "Scout",
      job: "Reads the code.",
      purpose: "Reads the code.",
      instructions: "",
      tone: 100,
      sendsDeveloper: false,
    });
  });

  it("never lets the model pick the engine or autonomy", () => {
    expect(hatchSystemPrompt()).toContain("Do not choose a model, engine, or autonomy");
  });

  it("keeps Hatch from asking the name first or offering type chips", () => {
    expect(
      parseHatchDecision(
        '{"say":"what should it do when the project needs to change?","ready":false,"name":"","job":"","sendsDeveloper":false,"limits":""}',
      )?.spec,
    ).toBeNull();
    expect(
      parseHatchDecision(
        '{"say":"building smartie.","ready":true,"name":"Smartie","job":"listens and follows up","sendsDeveloper":false,"limits":""}',
      )?.spec,
    ).toMatchObject({ name: "Smartie", sendsDeveloper: false });
    const hatch = hatchSystemPrompt();
    expect(hatch).toContain("Do not ask for a name first");
    expect(hatch).toContain("Do not offer research, review, plan, or build");
  });
});
