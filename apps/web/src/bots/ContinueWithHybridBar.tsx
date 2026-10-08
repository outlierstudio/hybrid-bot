import { HYBRID_BOT_COLOR } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { PartnerFace } from "./PartnerFace";

/**
 * HYBRID: stands in for the composer on an old thread that has no partner. Messages there
 * are read-only until the user continues the thread with Hybrid.
 */
export function ContinueWithHybridBar(props: {
  /** Resolves false when the thread could not be continued, so the button comes back. */
  readonly onContinue: () => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <div
      data-testid="continue-with-hybrid"
      className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2.5 text-card-foreground"
    >
      <PartnerFace color={HYBRID_BOT_COLOR} className="size-6" />
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        This thread is from before Hybrid, so it's read-only.
      </p>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void props.onContinue().then((ok) => {
            if (!ok) setPending(false);
          });
        }}
      >
        Continue with Hybrid
      </Button>
    </div>
  );
}
