import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_APP_CONTROL_NAMESPACE,
  resolveDesktopAppControlAddress,
} from "./desktopAppControl.ts";

describe("resolveDesktopAppControlAddress", () => {
  it("keeps Unix socket paths short and separates desktop state directories", () => {
    const first = resolveDesktopAppControlAddress({
      stateDir: `/home/user/${"long/".repeat(40)}userdata`,
      platform: "linux",
      tempDir: "/tmp",
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });
    const second = resolveDesktopAppControlAddress({
      stateDir: "/home/user/.hybrid/other/userdata",
      platform: "linux",
      tempDir: "/tmp",
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });

    expect(DESKTOP_APP_CONTROL_NAMESPACE).toBe("hybrid");
    expect(first.directory).toBe("/tmp/hybrid-1000");
    expect(first.address.length).toBeLessThan(108);
    expect(first.address).not.toBe(second.address);
  });

  it("uses a Windows named pipe under the same namespace", () => {
    const result = resolveDesktopAppControlAddress({
      stateDir: "C:\\Users\\user\\.hybrid\\userdata",
      platform: "win32",
      tempDir: "C:\\Temp",
      userId: undefined,
      joinPath: (...segments) => segments.join("\\"),
    });

    expect(result.directory).toBeNull();
    expect(result.address).toMatch(/^\\\\\.\\pipe\\hybrid-app-[a-f0-9]{24}$/);
  });

  it("hashes the same stateDir to the same address for CLI and desktop", () => {
    const input = {
      stateDir: "/home/user/.hybrid/dev",
      platform: "darwin" as const,
      tempDir: "/tmp",
      userId: 501,
      joinPath: (...segments: readonly string[]) => segments.join("/"),
    };
    expect(resolveDesktopAppControlAddress(input)).toEqual(resolveDesktopAppControlAddress(input));
  });
});
