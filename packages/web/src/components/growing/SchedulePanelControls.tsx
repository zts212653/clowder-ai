import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';

/** Scope and reversible personal-view controls, separate from the original calendar/reader owner. */
export function SchedulePanelControls({
  scope,
  showIgnored,
  disabled,
  error,
  hasUndo,
  onRefresh,
  onScope,
  onIgnored,
  onUndo,
  onDismissUndo,
}: {
  scope: 'active' | 'completed';
  showIgnored: boolean;
  disabled: boolean;
  error: 'unavailable' | 'conflict' | null;
  hasUndo: boolean;
  onRefresh: () => void;
  onScope: (scope: 'active' | 'completed') => void;
  onIgnored: () => void;
  onUndo: () => void;
  onDismissUndo: () => void;
}) {
  const t = useShellCopy(scheduleCopy);
  return (
    <>
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-cafe-black">{t.title}</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface"
        >
          {t.refresh}
        </button>
      </header>
      <fieldset className="mb-4 flex gap-4 border-b border-cafe-subtle text-sm" aria-label={t.scope}>
        {(['active', 'completed'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={scope === value && !showIgnored}
            className={
              scope === value && !showIgnored
                ? 'border-b-2 border-cafe-accent pb-2 font-semibold text-cafe-accent'
                : 'pb-2 text-cafe-muted'
            }
            onClick={() => onScope(value)}
          >
            {t[value]}
          </button>
        ))}
        {scope === 'active' ? (
          <button
            type="button"
            data-testid="schedule-open-ignored"
            aria-pressed={showIgnored}
            disabled={disabled}
            className="pb-2 text-cafe-muted disabled:opacity-50"
            onClick={onIgnored}
          >
            {t.ignored}
          </button>
        ) : null}
      </fieldset>
      {error ? (
        <output data-testid="schedule-preferences-error" className="mb-3 block text-xs text-semantic-critical">
          {error === 'conflict' ? t.preferenceConflict : t.preferenceUnavailable}
        </output>
      ) : null}
      {hasUndo ? (
        <div className="mb-3 flex gap-3 text-xs">
          <button type="button" disabled={disabled} className="text-cafe-accent" onClick={onUndo}>
            {t.undo}
          </button>
          <button type="button" className="text-cafe-muted" onClick={onDismissUndo}>
            {t.dismissUndo}
          </button>
        </div>
      ) : null}
    </>
  );
}
