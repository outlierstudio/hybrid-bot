import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { WS_METHODS, type HatchTranscriptMessage } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useState } from "react";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { connectionAtomRuntime } from "../connection/runtime";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerSettingsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { composeHatchedBot, draftFromSpec, resolveHatchEngine, type HatchDraft } from "./hatchBot";
import { PartnerFace } from "./PartnerFace";
import { selectPartnerBot, setPendingDraftPartnerBot } from "./partnerSelection";
import { useBots } from "./useBots";

const botsUpsert = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:upsert",
  tag: WS_METHODS.botsUpsert,
});

const hatchTurn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "hybrid:bots:hatch-turn",
  tag: WS_METHODS.botsHatchTurn,
});

const HATCH_COLOR = "#f5d76e";
const OPENING = "what do you want this bot to do for you?";

export function HatchOnboarding() {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const projects = useProjects();
  const threads = useThreadShells();
  const environmentId = usePrimaryEnvironmentId();
  const settings = useAtomValue(primaryServerSettingsAtom);
  const { allBots } = useBots();
  const upsert = useAtomCommand(botsUpsert, { reportFailure: true });
  const ask = useAtomCommand(hatchTurn, { reportFailure: true });
  const [messages, setMessages] = useState<readonly HatchTranscriptMessage[]>([
    { role: "hatch", text: OPENING },
  ]);
  const [draft, setDraft] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<HatchDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const engine = resolveHatchEngine(settings);

  const create = async () => {
    if (!preview || !environmentId || saving) return;
    const name = preview.name.trim();
    if (name.length < 2 || preview.instructions.trim().length === 0) {
      setError("give it a name and some instructions first.");
      return;
    }
    setSaving(true);
    setError(null);
    const built = composeHatchedBot({
      draft: preview,
      engine,
      takenHandles: new Set(allBots.map((bot) => bot.handle)),
    });
    const result = await upsert({ environmentId, input: built });
    if (result._tag !== "Success") {
      setSaving(false);
      setError("could not save that bot. try again.");
      return;
    }
    // Land in a fresh chat with the new bot, not back on whatever was open.
    selectPartnerBot(result.value.id);
    setPendingDraftPartnerBot(result.value.id);
    const project = sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;
    if (project === null) {
      void navigate({ to: "/" });
      return;
    }
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
      () => null,
    );
    if (opened === null) void navigate({ to: "/" });
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (text.length === 0 || busy || preview || !environmentId) return;
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    setDraft("");
    setError(null);
    setBusy(true);
    const modelSelection =
      settings.defaultModelSelection ?? settings.textGenerationModelSelection ?? undefined;
    void ask({
      environmentId,
      input: {
        messages: next,
        ...(modelSelection ? { modelSelection } : {}),
      },
    }).then((result) => {
      setBusy(false);
      if (result._tag !== "Success") {
        setError("that didn't go through. try again.");
        return;
      }
      setMessages((current) => [...current, { role: "hatch", text: result.value.say }]);
      if (result.value.spec) setPreview(draftFromSpec(result.value.spec));
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <PartnerFace color={HATCH_COLOR} className={cn("size-14", preview && "hatch-bob")} />
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-medium tracking-tight">Hatch</h1>
            <button
              type="button"
              aria-expanded={aboutOpen}
              aria-label={aboutOpen ? "Minimize" : "Maximize"}
              onClick={() => setAboutOpen((open) => !open)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {aboutOpen ? (
                <Minimize2Icon className="size-4" />
              ) : (
                <Maximize2Icon className="size-4" />
              )}
            </button>
          </div>
          {aboutOpen ? (
            <p className="text-sm text-muted-foreground">
              asks a few questions, then builds the bot.
            </p>
          ) : null}
        </div>
      </div>

      <ul className="mt-6 flex w-full max-w-md flex-col gap-2 text-sm">
        {messages.map((message, index) => (
          <li
            key={`${message.role}-${index}`}
            className={cn("leading-relaxed", message.role === "user" && "text-muted-foreground")}
          >
            {message.text}
          </li>
        ))}
        {busy ? <li className="text-muted-foreground">hatch is on it..</li> : null}
      </ul>

      {preview ? (
        <HatchPreviewCard
          draft={preview}
          engineLabel={engine ? engine.model : null}
          saving={saving}
          onChange={setPreview}
          onCreate={() => void create()}
          onBack={() => setPreview(null)}
        />
      ) : null}

      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

      {preview ? null : (
        <form
          className="relative mt-8 w-full rounded-3xl bg-(--chat-composer-glass-surface,var(--card)) p-3 shadow-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
        >
          <label className="sr-only" htmlFor="hatch-draft">
            Message Hatch
          </label>
          <textarea
            id="hatch-draft"
            value={draft}
            rows={2}
            autoFocus
            disabled={busy}
            placeholder="Message Hatch"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
            className="w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              aria-label="Send"
              disabled={busy || draft.trim().length === 0}
              className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function HatchPreviewCard(props: {
  readonly draft: HatchDraft;
  readonly engineLabel: string | null;
  readonly saving: boolean;
  readonly onChange: (draft: HatchDraft) => void;
  readonly onCreate: () => void;
  readonly onBack: () => void;
}) {
  const { draft, onChange } = props;
  return (
    <section
      aria-label="New bot preview"
      className="hatch-rise mt-5 flex w-full max-w-md flex-col gap-3 rounded-2xl border bg-card p-4 text-left text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">name</span>
        <Input
          size="sm"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">purpose</span>
        <Input
          size="sm"
          value={draft.purpose}
          onChange={(event) => onChange({ ...draft, purpose: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">instructions</span>
        <Textarea
          size="sm"
          rows={6}
          value={draft.instructions}
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-muted-foreground">
          <span>tone</span>
          <span>{draft.tone < 34 ? "chill" : draft.tone > 66 ? "professional" : "balanced"}</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={draft.tone}
          aria-label="Tone"
          onChange={(event) => onChange({ ...draft, tone: Number(event.currentTarget.value) })}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block">can send a developer</span>
          <span className="block text-muted-foreground">
            always asks you first. change that in settings.
          </span>
        </span>
        <Switch
          checked={draft.sendsDeveloper}
          aria-label="Can send a developer"
          onCheckedChange={(checked) => onChange({ ...draft, sendsDeveloper: checked })}
        />
      </div>
      <p className="text-muted-foreground">
        engine:{" "}
        {props.engineLabel ? `your current model (${props.engineLabel})` : "project default"}
      </p>
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={props.onBack} disabled={props.saving}>
          keep talking
        </Button>
        <Button size="xs" onClick={props.onCreate} disabled={props.saving}>
          {props.saving ? "creating.." : "create bot"}
        </Button>
      </div>
    </section>
  );
}
