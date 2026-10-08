import type { DeveloperTaskConfirmationDecision } from "@t3tools/contracts";
import { memo, useState } from "react";

import { Button } from "../components/ui/button";
import type { DeveloperPlanCardModel } from "./developerPlan";

export const DeveloperPlanCard = memo(function DeveloperPlanCard(props: {
  readonly plan: DeveloperPlanCardModel;
  readonly onResolve: ((decision: DeveloperTaskConfirmationDecision) => Promise<unknown>) | null;
}) {
  const { plan, onResolve } = props;
  const [busy, setBusy] = useState(false);
  const resolve = (decision: DeveloperTaskConfirmationDecision) => {
    if (onResolve === null || busy) return;
    setBusy(true);
    // The card leaves with the server's resolved activity. A failed call puts the buttons back.
    void onResolve(decision).finally(() => setBusy(false));
  };

  return (
    <div
      className="relative max-w-[80%] rounded-2xl border border-border bg-card px-3 py-2.5 text-card-foreground"
      data-testid="developer-plan-card"
    >
      <p className="text-xs text-muted-foreground">Plan</p>
      <p className="mt-0.5 text-sm font-medium wrap-break-word">{plan.goal}</p>
      {plan.summary.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground wrap-break-word">{plan.summary}</p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" disabled={busy || onResolve === null} onClick={() => resolve("confirm")}>
          Go ahead
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || onResolve === null}
          onClick={() => resolve("decline")}
        >
          Not now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || onResolve === null}
          onClick={() => resolve("edit")}
        >
          Edit
        </Button>
      </div>
    </div>
  );
});
