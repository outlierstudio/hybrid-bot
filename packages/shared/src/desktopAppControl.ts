import { sha256 } from "@noble/hashes/sha2";

export interface DesktopAppControlAddress {
  readonly address: string;
  readonly directory: string | null;
}

/**
 * Shared by the Hybrid desktop shell and `t3 app` CLI. Keep this one constant —
 * both sides must hash the same stateDir into the same socket/pipe.
 */
export const DESKTOP_APP_CONTROL_NAMESPACE = "hybrid";

function shortHash(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Returns the local-only socket address shared by the desktop shell and CLI.
 * The state directory is hashed so custom Hybrid homes cannot exceed Unix socket
 * path limits.
 */
export function resolveDesktopAppControlAddress(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly tempDir: string;
  readonly userId: number | undefined;
  readonly joinPath: (...segments: readonly string[]) => string;
}): DesktopAppControlAddress {
  const stateHash = shortHash(input.stateDir);
  if (input.platform === "win32") {
    return {
      address: `\\\\.\\pipe\\${DESKTOP_APP_CONTROL_NAMESPACE}-app-${stateHash}`,
      directory: null,
    };
  }

  const userKey =
    input.userId === undefined ? shortHash(input.stateDir).slice(0, 12) : input.userId;
  const directory = input.joinPath(input.tempDir, `${DESKTOP_APP_CONTROL_NAMESPACE}-${userKey}`);
  return {
    address: input.joinPath(directory, `${stateHash}.sock`),
    directory,
  };
}
