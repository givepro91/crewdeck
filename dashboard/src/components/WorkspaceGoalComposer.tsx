import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type GoalListItem } from "../lib/api";
import { useModalA11y } from "../hooks/useModalA11y";

interface WorkspaceGoalComposerProps {
  projectId: string;
  onCreated: (goal: GoalListItem, blueprintStarted: boolean) => void;
  onClose: () => void;
}

type GoalSuggestion = { title: string; description: string; priority: string; reason: string };

export function WorkspaceGoalComposer({ projectId, onCreated, onClose }: WorkspaceGoalComposerProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [acceptanceScript, setAcceptanceScript] = useState("");
  const [startBlueprint, setStartBlueprint] = useState(true);
  const [suggestions, setSuggestions] = useState<GoalSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalA11y<HTMLElement>(onClose);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      setSuggestions(await api.goals.suggest(projectId, 3, sourceMaterial.trim() || undefined));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceGoalSuggestFailed"));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const goal = await api.goals.create({
        project_id: projectId,
        title: title.trim(),
        description: description.trim(),
        ...(acceptanceScript.trim() ? { acceptance_script: acceptanceScript.trim() } : {}),
        ...(sourceMaterial.trim() ? { source_material: sourceMaterial.trim() } : {}),
      }) as GoalListItem & { autopilotHandled?: boolean };
      const shouldGenerate = startBlueprint && goal.autopilotHandled !== true;
      if (shouldGenerate) await api.goals.generateSpec(goal.id);
      onCreated(goal, startBlueprint);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceGoalCreateFailed"));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-goal-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="workspace-goal-title" className="text-sm font-semibold text-fg">{t("workspaceNewGoal")}</h2>
            <p className="mt-1 text-xs text-muted">{t("workspaceNewGoalHint")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("close")} className="rounded p-1 text-faint hover:bg-fg/5">×</button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block text-xs font-medium text-muted">
            {t("workspaceGoalMaterial")}
            <textarea
              rows={5}
              value={sourceMaterial}
              onChange={(event) => setSourceMaterial(event.target.value)}
              placeholder={t("workspaceGoalMaterialPlaceholder")}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-fg outline-none focus:border-accent"
            />
          </label>
          <div className="flex justify-end">
            <button type="button" onClick={() => void suggest()} disabled={busy} className="rounded-lg border border-accent px-3 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">
              {t("workspaceSuggestGoals")}
            </button>
          </div>
          {suggestions.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.title}-${suggestion.priority}`}
                  type="button"
                  onClick={() => { setTitle(suggestion.title); setDescription(suggestion.description); }}
                  className="rounded-lg border border-line bg-elevated p-3 text-left hover:border-accent"
                >
                  <span className="block text-xs font-medium text-fg">{suggestion.title}</span>
                  <span className="mt-1 block line-clamp-3 text-[10px] text-muted">{suggestion.reason || suggestion.description}</span>
                </button>
              ))}
            </div>
          )}
          <label className="block text-xs font-medium text-muted">
            {t("goalTitleLabel")}
            <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1.5 w-full rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
          </label>
          <label className="block text-xs font-medium text-muted">
            {t("goalDescLabel")}
            <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1.5 w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
          </label>
          <label className="block text-xs font-medium text-muted">
            {t("acceptanceScriptLabel")}
            <textarea rows={2} value={acceptanceScript} onChange={(event) => setAcceptanceScript(event.target.value)} className="mt-1.5 w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent" />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-line bg-elevated p-3 text-xs text-muted">
            <input type="checkbox" checked={startBlueprint} onChange={(event) => setStartBlueprint(event.target.checked)} className="mt-0.5" />
            <span><strong className="block text-fg">{t("workspaceStartBlueprint")}</strong>{t("workspaceStartBlueprintHint")}</span>
          </label>
          {error && <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-muted hover:bg-fg/5">{t("cancel")}</button>
          <button type="button" onClick={() => void create()} disabled={!title.trim() || busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">
            {busy ? t("loading") : startBlueprint ? t("workspaceCreateAndPlan") : t("workspaceCreateGoalOnly")}
          </button>
        </footer>
      </section>
    </div>
  );
}
