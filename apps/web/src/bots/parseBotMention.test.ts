import { describe, expect, it } from "vite-plus/test";
import { parseBotMention } from "./parseBotMention";

describe("parseBotMention", () => {
  it("parses leading @research with text", () => {
    expect(parseBotMention("@research why x")).toEqual({
      kind: "mention",
      botHandle: "research",
      text: "why x",
    });
  });

  it("does not treat email as a mention", () => {
    expect(parseBotMention("email@x.com")).toEqual({ kind: "none", text: "email@x.com" });
  });

  it("ignores mid-sentence @handle in MVP", () => {
    expect(parseBotMention("please ask @research later")).toEqual({
      kind: "none",
      text: "please ask @research later",
    });
  });

  it("returns trigger query while typing", () => {
    expect(parseBotMention("@re")).toEqual({ kind: "trigger", query: "re" });
    expect(parseBotMention("@")).toEqual({ kind: "trigger", query: "" });
  });

  it("unknown handle still parses as mention (resolution is elsewhere)", () => {
    expect(parseBotMention("@unknown hello")).toEqual({
      kind: "mention",
      botHandle: "unknown",
      text: "hello",
    });
  });
});
