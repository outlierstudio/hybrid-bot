import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The decision card's Approve / Deny / Always allow / answer. The server decides what each does. */
export const resolvePartnerDecision = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:resolve-partner-decision",
  tag: WS_METHODS.botsResolvePartnerDecision,
});
