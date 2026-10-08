/**
 * // HYBRID: compact partner/developer engine picker for BotSettings.
 * Null means "use the project/thread default".
 */
import { useAtomValue } from "@effect/atom-react";
import { createModelSelection } from "@t3tools/shared/model";
import { isHybridEngineDriver, type BotEngine, type ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { useScopedSettings } from "../components/settings/useScopedSettings";

export function BotEnginePicker(props: {
  readonly value: BotEngine | null | undefined;
  readonly ariaLabel: string;
  readonly onChange: (engine: BotEngine | null) => void;
}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const settings = useScopedSettings();
  // HYBRID: only Claude and Codex can run Hybrid's engines (read-only partner + toolkit).
  const providers = useAtomValue(primaryServerProvidersAtom).filter((provider) =>
    isHybridEngineDriver(provider.driver),
  );
  const fallback = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  // A saved engine on another driver falls back to the default Claude/Codex engine.
  const savedUnsupported =
    props.value != null && !entries.some((entry) => entry.instanceId === props.value?.instanceId);
  const selection =
    props.value && !savedUnsupported
      ? {
          instanceId: props.value.instanceId,
          model: props.value.model,
          options: props.value.options,
        }
      : fallback;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = selection
    ? entries.find((entry) => entry.instanceId === selection.instanceId)
    : undefined;

  if (!selection || !activeEntry) {
    return <span className="text-sm text-muted-foreground">No providers available</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        triggerAriaLabel={props.ariaLabel}
        {...(props.value == null || savedUnsupported ? { triggerLabel: "Project default" } : {})}
        onOpenProviderSetup={(instanceId: ProviderInstanceId) => {
          if (environmentId)
            void navigate({
              to: "/settings/providers",
              search: { environmentId, instanceId },
            });
        }}
        onInstanceModelChange={(instanceId, model) => {
          props.onChange(createModelSelection(instanceId, model));
        }}
      />
      {props.value != null ? (
        <Button size="xs" variant="ghost" onClick={() => props.onChange(null)}>
          Default
        </Button>
      ) : null}
      {savedUnsupported ? (
        <p className="w-full text-right text-xs text-muted-foreground">
          The saved engine isn't Claude or Codex, so Hybrid uses the default instead.
        </p>
      ) : null}
    </div>
  );
}
