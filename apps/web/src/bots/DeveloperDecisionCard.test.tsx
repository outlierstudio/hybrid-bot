import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DeveloperDecisionCard, type PartnerDecisionAnswer } from "./DeveloperDecisionCard";
import type { PartnerDecisionCardModel } from "./developerDecision";

const model = (overrides: Partial<PartnerDecisionCardModel>): PartnerDecisionCardModel => ({
  cardId: "c1",
  kind: "approval",
  question: "Push to main?",
  options: [],
  approvalClass: "production",
  alwaysAllow: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const render = (decision: PartnerDecisionCardModel, withResolve = true) =>
  renderToStaticMarkup(
    <DeveloperDecisionCard
      decision={decision}
      onResolve={withResolve ? () => Promise.resolve() : null}
    />,
  );

describe("DeveloperDecisionCard", () => {
  it("draws Approve, Deny, and Always allow for a classified approval", () => {
    const html = render(model({}));
    expect(html).toContain("Push to main?");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("Always allow (this project)");
    expect(html).not.toContain("Type an answer");
  });

  it("names exactly what Always allow remembers", () => {
    const html = render(model({ alwaysAllow: [{ key: "git push origin master", kind: null }] }));
    expect(html).toContain("<code");
    expect(html).toContain("git push origin master");
    expect(html).toContain("in this project");
    expect(html).not.toContain("(this project)");
  });

  it("says when the remembered command is remote or inline code", () => {
    const html = render(
      model({
        alwaysAllow: [
          { key: "ssh host 'rm -rf /srv'", kind: "remote" },
          { key: "node -e 'x()'", kind: "inline" },
        ],
      }),
    );
    expect(html).toContain("the remote command ");
    expect(html).toContain("the inline code ");
  });

  it("leaves out Always allow when the request has no class", () => {
    const html = render(model({ approvalClass: null }));
    expect(html).toContain("Approve");
    expect(html).not.toContain("Always allow");
  });

  it("draws option buttons and a text box for a question", () => {
    const html = render(
      model({ kind: "question", question: "Which package?", options: ["web", "server"] }),
    );
    expect(html).toContain("Which package?");
    expect(html).toContain(">web<");
    expect(html).toContain(">server<");
    expect(html).toContain("Type an answer");
    expect(html).not.toContain("Approve");
  });

  it("disables the buttons when the card cannot be resolved", () => {
    const html = render(model({}), false);
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
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

    const mount = async (
      decision: PartnerDecisionCardModel,
      onResolve: (answer: PartnerDecisionAnswer) => Promise<unknown>,
    ) => {
      await act(() => {
        renderer = create(<DeveloperDecisionCard decision={decision} onResolve={onResolve} />);
      });
      return renderer!.root;
    };

    const textOf = (node: ReactTestInstance): string =>
      node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

    const buttonLabelled = (root: ReactTestInstance, label: string) => {
      const found = root
        .findAllByType("button")
        .filter((button) => textOf(button).trim() === label);
      expect(found, `a "${label}" button`).toHaveLength(1);
      return found[0]!;
    };

    const press = async (root: ReactTestInstance, label: string) => {
      const button = buttonLabelled(root, label);
      await act(() => {
        button.props.onClick();
      });
    };

    it.each([
      ["Approve", { decision: "accept" }],
      ["Deny", { decision: "decline" }],
      ["Always allow (this project)", { decision: "always_allow" }],
    ] as const)("%s on an approval card resolves with %j", async (label, expected) => {
      const onResolve = vi.fn((_answer: PartnerDecisionAnswer) => Promise.resolve());
      const root = await mount(model({}), onResolve);
      await press(root, label);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(expected);
    });

    it("answers a question with an option button", async () => {
      const onResolve = vi.fn((_answer: PartnerDecisionAnswer) => Promise.resolve());
      const root = await mount(
        model({ kind: "question", question: "Which package?", options: ["web", "server"] }),
        onResolve,
      );
      await press(root, "server");
      expect(onResolve).toHaveBeenCalledWith({ decision: "accept", selectedOption: "server" });
    });

    it("answers a question with free text, and skips with a decline", async () => {
      const onResolve = vi.fn((_answer: PartnerDecisionAnswer) => Promise.resolve());
      const root = await mount(
        model({ kind: "question", question: "Which package?", options: ["web"] }),
        onResolve,
      );

      // Send stays disabled until something is typed, and an empty submit sends nothing.
      expect(buttonLabelled(root, "Send").props.disabled).toBe(true);
      const form = root.findByType("form");
      await act(() => {
        form.props.onSubmit({ preventDefault: () => undefined });
      });
      expect(onResolve).not.toHaveBeenCalled();

      await act(() => {
        root.findByType("input").props.onChange({
          target: { value: "  packages/api  " },
          currentTarget: { value: "  packages/api  " },
        });
      });
      expect(buttonLabelled(root, "Send").props.disabled).toBe(false);
      await act(() => {
        form.props.onSubmit({ preventDefault: () => undefined });
      });
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenLastCalledWith({
        decision: "accept",
        answerText: "packages/api",
      });
    });

    it("skips a question with a decline", async () => {
      const onResolve = vi.fn((_answer: PartnerDecisionAnswer) => Promise.resolve());
      const root = await mount(model({ kind: "question", question: "Which one?" }), onResolve);
      await press(root, "Skip");
      expect(onResolve).toHaveBeenCalledWith({ decision: "decline" });
    });

    it("answers once while a resolution is in flight", async () => {
      let finish: () => void = () => undefined;
      const onResolve = vi.fn(
        (_answer: PartnerDecisionAnswer) =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const root = await mount(model({}), onResolve);
      await press(root, "Approve");
      await press(root, "Deny");
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(buttonLabelled(root, "Approve").props.disabled).toBe(true);

      // A settled call puts the buttons back.
      await act(async () => {
        finish();
      });
      expect(buttonLabelled(root, "Approve").props.disabled).toBe(false);
    });
  });
});
