import { createFileRoute } from "@tanstack/react-router";

import { BotSettings } from "../bots/BotSettings";

function SettingsBotsRoute() {
  return <BotSettings />;
}

export const Route = createFileRoute("/settings/bots")({
  component: SettingsBotsRoute,
});
