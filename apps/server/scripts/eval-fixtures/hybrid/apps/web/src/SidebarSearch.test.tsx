import { describe, expect, it } from "vitest";
import { SidebarSearch } from "./SidebarSearch";

describe("SidebarSearch", () => {
  it("matches Foo when typing foo (currently flaky / case-sensitive)", () => {
    expect(SidebarSearch({ query: "foo", items: ["Foo"] })).toEqual(["Foo"]);
  });
});
