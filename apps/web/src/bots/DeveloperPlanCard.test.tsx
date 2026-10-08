import type { DeveloperTaskConfirmationDecision } from "@t3tools/contracts";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DeveloperPlanCard } from "./DeveloperPlanCard";
import type { DeveloperPlanCardModel } from "./developerPlan";

const plan: DeveloperPlanCardModel = {
  taskId: "task-1",
  goal: "Fix the login redirect",
  summary: "See src/login.ts",
  scope: "small",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("DeveloperPlanCard", () => {
  it("draws Go ahead, Not now, and Edit", () => {
    const html = renderToStaticMarkup(
      <DeveloperPlanCard plan={plan} onResolve={() => Promise.resolve()} />,
    );
    expect(html).toContain("Fix the login redirect");
    expect(html).toContain("Go ahead");
    expect(html).toContain("Not now");
    expect(html).toContain("Edit");
  });

  it("disables every button until a resolver is wired", () => {
    const html = renderToStaticMarkup(<DeveloperPlanCard plan={plan} onResolve={null} />);
    expect(html.match(/<button[^>]*\sdisabled=""/g)?.length).toBe(3);
  });

  describe("interaction", () => {
    let renderer: ReactTestRenderer | undefined;

    beforeEach(() => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    });

    afterEach(async () => {
      await act(() => renderer?.unmount());
      renderer = undefined;
      vi.unstubAllGlobals();
    });

    const textOf = (node: ReactTestInstance): string =>
      node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

    const mount = async (
      onResolve: (decision: DeveloperTaskConfirmationDecision) => Promise<unknown>,
    ) => {
      await act(() => {
        renderer = create(<DeveloperPlanCard plan={plan} onResolve={onResolve} />);
      });
      return renderer!.root;
    };

    const buttonLabelled = (root: ReactTestInstance, label: string) => {
      const found = root
        .findAllByType("button")
        .filter((button) => textOf(button).trim() === label);
      expect(found, `a "${label}" button`).toHaveLength(1);
      return found[0]!;
    };

    it.each([
      ["Go ahead", "confirm"],
      ["Not now", "decline"],
      ["Edit", "edit"],
    ] as const)("%s resolves the plan with %s", async (label, decision) => {
      const onResolve = vi.fn((_decision: DeveloperTaskConfirmationDecision) => Promise.resolve());
      const root = await mount(onResolve);
      await act(() => {
        buttonLabelled(root, label).props.onClick();
      });
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(decision);
    });

    it("resolves once while a decision is in flight, then re-enables on settle", async () => {
      let finish: () => void = () => undefined;
      const onResolve = vi.fn(
        (_decision: DeveloperTaskConfirmationDecision) =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const root = await mount(onResolve);
      await act(() => {
        buttonLabelled(root, "Go ahead").props.onClick();
      });
      await act(() => {
        buttonLabelled(root, "Not now").props.onClick();
      });
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(buttonLabelled(root, "Edit").props.disabled).toBe(true);

      await act(async () => {
        finish();
      });
      expect(buttonLabelled(root, "Edit").props.disabled).toBe(false);
    });
  });
});
