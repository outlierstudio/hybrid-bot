import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ContinueWithHybridBar } from "./ContinueWithHybridBar";

describe("ContinueWithHybridBar", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("continues the thread with Hybrid once, then waits for the composer to return", async () => {
    const onContinue = vi.fn(() => Promise.resolve(true));
    await act(() => {
      renderer = create(<ContinueWithHybridBar onContinue={onContinue} />);
    });
    const button = renderer!.root.findByProps({ children: "Continue with Hybrid" });
    await act(() => {
      button.props.onClick();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByProps({ children: "Continue with Hybrid" }).props.disabled).toBe(
      true,
    );
  });

  it("brings the button back when continuing fails", async () => {
    await act(() => {
      renderer = create(<ContinueWithHybridBar onContinue={() => Promise.resolve(false)} />);
    });
    await act(async () => {
      renderer!.root.findByProps({ children: "Continue with Hybrid" }).props.onClick();
    });
    expect(renderer!.root.findByProps({ children: "Continue with Hybrid" }).props.disabled).toBe(
      false,
    );
  });
});
