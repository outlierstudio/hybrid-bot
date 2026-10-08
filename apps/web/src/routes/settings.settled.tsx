import { createFileRoute } from "@tanstack/react-router";

import { SettledThreadsPanel } from "../components/settings/SettledThreadsPanel";

export const Route = createFileRoute("/settings/settled")({
  component: SettledThreadsPanel,
});
