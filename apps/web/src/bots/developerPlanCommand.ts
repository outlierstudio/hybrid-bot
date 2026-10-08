import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The plan card's Go ahead / Not now / Edit. The server decides what each does. */
export const resolveTaskConfirmation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:resolve-task-confirmation",
  tag: WS_METHODS.botsResolveTaskConfirmation,
});
