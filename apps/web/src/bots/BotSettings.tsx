/**
 * // HYBRID: Settings → Bots editor (v2: purpose / tone / autonomy / engines / archive).
 * With multi-bot off this is the single Hybrid page.
 */
import {
  HYBRID_BOT_ID,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  WS_METHODS,
  type Bot,
  type BotAutonomy,
  type BotUpsertInput,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useMemo, useRef, useState } from "react";

import { BotEnginePicker } from "./BotEnginePicker";
import {
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  DEFAULT_BOT_COLOR,
  botToUpsertInput,
  clampTone,
  emptyBotDraft,
  isBotAutonomy,
  toneLabel,
  withAutonomy,
  withCanDelegate,
} from "./botSettingsLogic";
import { BOT_FEATURES } from "./botFeatures";
import { PolicyRulesSettings } from "./PolicyRulesSettings";
import { useBots } from "./useBots";
import { ProviderAccentColorPicker } from "../components/settings/ProviderAccentColorPicker";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { connectionAtomRuntime } from "../connection/runtime";
import { ensureLocalApi } from "../localApi";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../state/environments";

const botsUpsert = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:upsert",
  tag: WS_METHODS.botsUpsert,
});
const botsArchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:archive",
  tag: WS_METHODS.botsArchive,
});
const botsUnarchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:unarchive",
  tag: WS_METHODS.botsUnarchive,
});
const botsReset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:reset",
  tag: WS_METHODS.botsResetBuiltIn,
});

const providerLabel = (provider: string) =>
  PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(provider)] ?? provider;

function downloadBotsJson(bots: readonly Bot[]) {
  const blob = new Blob([JSON.stringify(bots, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "hybrid-bots.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function botListDescription(bot: Bot): string {
  const engine = bot.partnerEngine?.model ?? "Project default";
  return [bot.purpose || AUTONOMY_LABELS[bot.autonomy], engine, AUTONOMY_LABELS[bot.autonomy]].join(
    " · ",
  );
}

function MultiBotSettings() {
  const { bots, archivedBots, allBots, isPending } = useBots();
  const environmentId = usePrimaryEnvironmentId();
  const upsert = useAtomCommand(botsUpsert, { reportFailure: true });
  const archive = useAtomCommand(botsArchive, { reportFailure: true });
  const unarchive = useAtomCommand(botsUnarchive, { reportFailure: true });
  const reset = useAtomCommand(botsReset, { reportFailure: true });
  const [draft, setDraft] = useState<BotUpsertInput>(emptyBotDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(
    () =>
      [...bots].sort(
        (a, b) => Number(b.builtIn) - Number(a.builtIn) || a.handle.localeCompare(b.handle),
      ),
    [bots],
  );

  const openEditor = (next: BotUpsertInput, id: string | null) => {
    setEditingId(id);
    setDraft(next);
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const save = async () => {
    if (!environmentId) return;
    await upsert({ environmentId, input: draft });
    setDraft(emptyBotDraft());
    setEditingId(null);
  };

  const archiveBot = async (bot: Bot) => {
    if (!environmentId) return;
    if (!(await ensureLocalApi().dialogs.confirm(`Archive @${bot.handle}?`))) return;
    await archive({ environmentId, input: { id: bot.id } });
  };

  const restoreBot = async (bot: Bot) => {
    if (!environmentId) return;
    await unarchive({ environmentId, input: { id: bot.id } });
  };

  const importBots = async (file: File) => {
    setImportError(null);
    if (!environmentId) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) {
        setImportError("Import file must be a JSON array of bots.");
        return;
      }
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const handle = typeof record.handle === "string" ? record.handle : "";
        const name = typeof record.name === "string" ? record.name : handle;
        if (!handle || !name) continue;
        const autonomy: BotAutonomy = isBotAutonomy(record.autonomy)
          ? record.autonomy
          : "ask-first";
        const canDelegate =
          typeof record.canDelegate === "boolean"
            ? record.canDelegate
            : !(typeof record.readOnly === "boolean" ? record.readOnly : true);
        const input: BotUpsertInput = {
          handle: handle.toLowerCase().slice(0, 32),
          name: name.slice(0, 64),
          color: typeof record.color === "string" ? record.color : DEFAULT_BOT_COLOR,
          instructions: typeof record.instructions === "string" ? record.instructions : "",
          purpose: typeof record.purpose === "string" ? record.purpose : "",
          tone: typeof record.tone === "number" ? clampTone(record.tone) : 50,
          autonomy,
          canDelegate,
          partnerEngine: null,
          developerEngine: null,
          provider: ProviderDriverKind.make(
            typeof record.provider === "string" ? record.provider : "codex",
          ),
          model: typeof record.model === "string" ? record.model : null,
          runtimeMode: withAutonomy(emptyBotDraft(), autonomy).runtimeMode,
          readOnly: !canDelegate,
          mcpServers: [],
        };
        await upsert({ environmentId, input });
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to import bots.");
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Bots"
        headerAction={
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => downloadBotsJson(allBots)}>
              Export
            </Button>
            <Button size="xs" variant="outline" onClick={() => importInputRef.current?.click()}>
              Import
            </Button>
            <Button size="xs" onClick={() => openEditor(emptyBotDraft(), null)}>
              New bot
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importBots(file);
              }}
            />
          </div>
        }
      >
        {importError ? <SettingsRow title="Import failed" description={importError} /> : null}
        {isPending && bots.length === 0 ? (
          <SettingsRow title="Loading bots…" />
        ) : (
          sorted.map((bot) => (
            <SettingsRow
              key={bot.id}
              title={
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: bot.color }}
                  />
                  @{bot.handle}
                  <span className="font-normal text-muted-foreground">{bot.name}</span>
                  {bot.builtIn ? (
                    <Badge variant="outline" size="sm">
                      Built-in
                    </Badge>
                  ) : null}
                  {bot.userModified && bot.builtIn ? (
                    <Badge variant="outline" size="sm">
                      Edited
                    </Badge>
                  ) : null}
                </span>
              }
              description={botListDescription(bot)}
              control={
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => openEditor(botToUpsertInput(bot), bot.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => openEditor(botToUpsertInput(bot, { duplicate: true }), null)}
                  >
                    Duplicate
                  </Button>
                  {bot.builtIn ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={async () => {
                        if (!environmentId) return;
                        await reset({ environmentId, input: { id: bot.id } });
                      }}
                    >
                      Reset
                    </Button>
                  ) : (
                    <Button size="xs" variant="ghost-destructive" onClick={() => archiveBot(bot)}>
                      Archive
                    </Button>
                  )}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>

      {archivedBots.length > 0 ? (
        <SettingsSection title="Archived bots">
          {archivedBots.map((bot) => (
            <SettingsRow
              key={bot.id}
              title={
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: bot.color }}
                  />
                  @{bot.handle}
                  <span className="font-normal text-muted-foreground">{bot.name}</span>
                </span>
              }
              description={botListDescription(bot)}
              control={
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => restoreBot(bot)}>
                    Restore
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      <div ref={editorRef}>
        <SettingsSection
          title={editingId ? `Edit @${draft.handle}` : "New bot"}
          headerAction={
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setDraft(emptyBotDraft());
                  setEditingId(null);
                }}
              >
                Clear
              </Button>
              <Button size="xs" onClick={save} disabled={!draft.handle || !draft.name}>
                Save
              </Button>
            </div>
          }
        >
          <SettingsRow
            title="Handle"
            description="Summon with @handle in any project thread."
            control={
              <Input
                size="sm"
                className="w-full sm:w-56"
                placeholder="research"
                value={draft.handle}
                onChange={(e) => setDraft({ ...draft, handle: e.target.value.toLowerCase() })}
              />
            }
          />
          <SettingsRow
            title="Name"
            control={
              <Input
                size="sm"
                className="w-full sm:w-56"
                placeholder="Research"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            }
          />
          <SettingsRow
            title="Purpose"
            description="One line shown under the bot's face."
            control={
              <Input
                size="sm"
                className="w-full sm:w-72"
                placeholder="Reads the code and explains it."
                value={draft.purpose ?? ""}
                onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
              />
            }
          />
          <SettingsRow
            title="Color"
            control={
              <ProviderAccentColorPicker
                layout="inline"
                displayName={draft.name || "bot"}
                value={draft.color}
                onCommit={(color) => setDraft({ ...draft, color: color || DEFAULT_BOT_COLOR })}
              />
            }
          />
          <SettingsRow title="Instructions">
            <Textarea
              className="mb-2"
              size="sm"
              rows={8}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
          </SettingsRow>
          <BotToneAutonomyRows draft={draft} setDraft={setDraft} />
          <SettingsRow
            title="Can send a developer"
            description="When on, the bot may start a developer task. It still follows autonomy."
            control={
              <Switch
                checked={draft.canDelegate ?? false}
                onCheckedChange={(checked) => setDraft(withCanDelegate(draft, checked))}
                aria-label="Can send a developer"
              />
            }
          />
          <BotEngineRows draft={draft} setDraft={setDraft} />
          <SettingsRow
            title="Legacy provider"
            description={`${providerLabel(draft.provider)} · kept for one release`}
            control={
              <span className="text-sm text-muted-foreground">{draft.model ?? "thread model"}</span>
            }
          />
        </SettingsSection>
      </div>

      <PolicyRulesSettings />
    </SettingsPageContainer>
  );
}

type DraftProps = {
  readonly draft: BotUpsertInput;
  readonly setDraft: (draft: BotUpsertInput) => void;
};

function BotToneAutonomyRows({ draft, setDraft }: DraftProps) {
  return (
    <>
      <SettingsRow
        title="Tone"
        description={toneLabel(draft.tone ?? 50)}
        control={
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            className="w-full sm:w-56"
            aria-label="Tone"
            value={draft.tone ?? 50}
            onChange={(e) => setDraft({ ...draft, tone: clampTone(Number(e.currentTarget.value)) })}
          />
        }
      />
      <SettingsRow
        title="Autonomy"
        description={AUTONOMY_DESCRIPTIONS[draft.autonomy ?? "ask-first"]}
        control={
          <Select
            value={draft.autonomy ?? "ask-first"}
            onValueChange={(value) => isBotAutonomy(value) && setDraft(withAutonomy(draft, value))}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Autonomy">
              <SelectValue>{AUTONOMY_LABELS[draft.autonomy ?? "ask-first"]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(AUTONOMY_LABELS) as BotAutonomy[]).map((value) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {AUTONOMY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function BotEngineRows({ draft, setDraft }: DraftProps) {
  return (
    <>
      <SettingsRow
        title="Partner engine"
        description="Model for the bot's own turns. Default follows the project."
        control={
          <BotEnginePicker
            value={draft.partnerEngine ?? null}
            ariaLabel="Partner engine"
            onChange={(partnerEngine) => setDraft({ ...draft, partnerEngine })}
          />
        }
      />
      <SettingsRow
        title="Developer engine"
        description="Model for developer tasks this bot starts. Default follows the project."
        control={
          <BotEnginePicker
            value={draft.developerEngine ?? null}
            ariaLabel="Developer engine"
            onChange={(developerEngine) => setDraft({ ...draft, developerEngine })}
          />
        }
      />
    </>
  );
}

/**
 * HYBRID: Settings for the one associate when multi-bot is off: tone, autonomy, engines,
 * and the approval rules. No bot list, create, archive, or import.
 */
function HybridBotSettings() {
  const { byId, isPending } = useBots();
  const hybrid = byId.get(HYBRID_BOT_ID) ?? null;
  const environmentId = usePrimaryEnvironmentId();
  const upsert = useAtomCommand(botsUpsert, { reportFailure: true });
  const reset = useAtomCommand(botsReset, { reportFailure: true });
  const [edits, setEdits] = useState<BotUpsertInput | null>(null);
  const draft = edits ?? (hybrid ? botToUpsertInput(hybrid) : null);

  const save = async () => {
    if (!environmentId || draft === null) return;
    await upsert({ environmentId, input: draft });
    setEdits(null);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Hybrid"
        headerAction={
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={hybrid === null}
              onClick={async () => {
                if (!environmentId) return;
                await reset({ environmentId, input: { id: HYBRID_BOT_ID } });
                setEdits(null);
              }}
            >
              Reset
            </Button>
            <Button size="xs" onClick={save} disabled={edits === null}>
              Save
            </Button>
          </div>
        }
      >
        {draft === null ? (
          <SettingsRow title={isPending ? "Loading Hybrid…" : "Hybrid isn't available yet."} />
        ) : (
          <>
            <SettingsRow
              title="Hybrid"
              description={hybrid?.purpose || "Your associate for this project."}
            />
            <BotToneAutonomyRows draft={draft} setDraft={setEdits} />
            <BotEngineRows draft={draft} setDraft={setEdits} />
          </>
        )}
      </SettingsSection>
      <PolicyRulesSettings />
    </SettingsPageContainer>
  );
}

export function BotSettings() {
  return BOT_FEATURES.botList ? <MultiBotSettings /> : <HybridBotSettings />;
}
