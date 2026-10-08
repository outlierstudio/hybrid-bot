import { createFileRoute, redirect } from "@tanstack/react-router";

import { BOT_FEATURES } from "../bots/botFeatures";
import { HatchOnboarding } from "../bots/HatchOnboarding";
import { SidebarInset } from "../components/ui/sidebar";

function NewBotRoute() {
  return (
    <SidebarInset className="flex min-h-0 flex-1 items-center justify-center px-6 pt-[var(--workspace-topbar-height)]">
      <HatchOnboarding />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/new-bot")({
  // HYBRID: Hatch is off with multi-bot off; land back in the chat.
  beforeLoad: () => {
    if (!BOT_FEATURES.hatch) throw redirect({ to: "/" });
  },
  component: NewBotRoute,
});
