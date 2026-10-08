import { Fragment, memo, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { PartnerDecisionCardModel } from "./developerDecision";

export interface PartnerDecisionAnswer {
  readonly decision: "accept" | "decline" | "always_allow";
  readonly answerText?: string;
  readonly selectedOption?: string;
}

export const DeveloperDecisionCard = memo(function DeveloperDecisionCard(props: {
  readonly decision: PartnerDecisionCardModel;
  readonly onResolve: ((answer: PartnerDecisionAnswer) => Promise<unknown>) | null;
}) {
  const { decision, onResolve } = props;
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const disabled = busy || onResolve === null;
  const answer = (value: PartnerDecisionAnswer) => {
    if (onResolve === null || busy) return;
    setBusy(true);
    // The card leaves with the server's resolved activity. A failed call puts the buttons back.
    void onResolve(value).finally(() => setBusy(false));
  };
  const typed = text.trim();

  return (
    <div
      className="relative max-w-[80%] rounded-2xl border border-border bg-card px-3 py-2.5 text-card-foreground"
      data-testid="developer-decision-card"
    >
      <p className="text-xs text-muted-foreground">
        {decision.kind === "approval" ? "Approval" : "Question"}
      </p>
      <p className="mt-0.5 text-sm font-medium wrap-break-word">{decision.question}</p>
      {decision.kind === "approval" ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={disabled} onClick={() => answer({ decision: "accept" })}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => answer({ decision: "decline" })}
          >
            Deny
          </Button>
          {decision.approvalClass !== null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => answer({ decision: "always_allow" })}
            >
              {decision.alwaysAllow.length > 0 ? (
                <span className="wrap-break-word">
                  Always allow{" "}
                  {decision.alwaysAllow.map((entry, index) => (
                    <Fragment key={entry.key}>
                      {index > 0 ? ", " : null}
                      {entry.kind === "remote"
                        ? "the remote command "
                        : entry.kind === "inline"
                          ? "the inline code "
                          : null}
                      <code className="font-mono">{entry.key}</code>
                    </Fragment>
                  ))}{" "}
                  in this project
                </span>
              ) : (
                "Always allow (this project)"
              )}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {decision.options.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {decision.options.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => answer({ decision: "accept", selectedOption: option })}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          <form
            className="mt-2.5 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.length > 0) answer({ decision: "accept", answerText: typed });
            }}
          >
            <Input
              size="sm"
              className="min-w-0 flex-1"
              placeholder="Type an answer"
              value={text}
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={disabled || typed.length === 0}>
              Send
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => answer({ decision: "decline" })}
            >
              Skip
            </Button>
          </form>
        </>
      )}
    </div>
  );
});
