/**
 * // HYBRID: Settings → Always-allow / policy rules list (AUDIT Phase 7).
 *
 * Rules are created from decision cards. This UI only lists and removes them.
 */
import { WS_METHODS, type PolicyRule } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { useMemo } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

const policyRulesListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "hybrid:policyRules:list",
  tag: WS_METHODS.policyRulesList,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

const policyRulesRemove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:policyRules:remove",
  tag: WS_METHODS.policyRulesRemove,
});

function scopeLabel(rule: PolicyRule): string {
  if (rule.scope === "global") return "All projects";
  if (rule.scope === "project")
    return rule.scopeId ? `Project ${rule.scopeId.slice(0, 8)}…` : "Project";
  return rule.scopeId ? `Bot ${rule.scopeId.slice(0, 8)}…` : "Bot";
}

function ruleTitle(rule: PolicyRule): string {
  if (rule.matchDetail && rule.matchDetail.length > 0) return rule.matchDetail;
  return rule.actionText.length > 0 ? rule.actionText : "(empty rule)";
}

export function PolicyRulesSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const atom = environmentId ? policyRulesListQuery({ environmentId, input: {} }) : null;
  const query = useEnvironmentQuery(atom);
  const remove = useAtomCommand(policyRulesRemove, { reportFailure: true });
  const rules = query.data?.rules ?? [];
  const sorted = useMemo(
    () => [...rules].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [rules],
  );

  return (
    <SettingsSection title="Approval rules">
      <SettingsRow
        title="Always-allow rules"
        description="Created from decision cards. Remove a rule to be asked again next time."
      />
      {query.isPending && rules.length === 0 ? (
        <SettingsRow title="Loading rules…" />
      ) : sorted.length === 0 ? (
        <SettingsRow
          title="No rules yet"
          description="When you tap Always allow on a decision card, it shows up here."
        />
      ) : (
        sorted.map((rule) => (
          <SettingsRow
            key={rule.id}
            title={ruleTitle(rule)}
            description={[scopeLabel(rule), rule.decision, rule.approvalClass ?? "free text"].join(
              " · ",
            )}
            control={
              <Button
                size="xs"
                variant="ghost-destructive"
                onClick={async () => {
                  if (!environmentId) return;
                  await remove({ environmentId, input: { id: rule.id } });
                  query.refresh();
                }}
              >
                Remove
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
