import { useShellCopy } from '../shell/shell-copy';
import { messageReadingCopy } from './message-reading-copy';

interface MessageSelectionBarProps {
  count: number;
  unselectedCardCount?: number;
  pendingFormat: 'md' | 'txt' | 'png' | null;
  error: string | null;
  forwardingDisabled: boolean;
  onExport: (format: 'md' | 'txt' | 'png') => void;
  onForward?: () => void;
  onCancel: () => void;
}

/** Presentation of the existing selection/export owner at the composer position. */
export function MessageSelectionBar({
  count,
  unselectedCardCount = 0,
  pendingFormat,
  error,
  forwardingDisabled,
  onExport,
  onForward,
  onCancel,
}: MessageSelectionBarProps) {
  const t = useShellCopy(messageReadingCopy);
  const disabled = count === 0 || pendingFormat !== null;
  return (
    <section
      aria-label={t.selectionActions}
      data-testid="message-selection-toolbar"
      data-selection-layout="reading-bar"
      className="border-t border-cafe bg-cafe-surface px-3 py-3"
    >
      <div className="mx-auto max-w-3xl">
        {error && (
          <p className="mb-2 text-xs text-conn-red-text" role="alert">
            {error}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-compact">
          <span className="mr-auto flex flex-wrap items-baseline gap-x-1.5 text-[13.5px] font-semibold tabular-nums text-cafe-primary">
            {t.selected(count)}
            {unselectedCardCount > 0 && (
              <span className="text-[12.5px] font-normal text-cafe-muted">
                {t.cardsNotSelected(unselectedCardCount)}
              </span>
            )}
          </span>
          <div role="group" aria-label={t.exportAs} className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="mr-1 text-cafe-muted">{t.exportAs}</span>
            {(['md', 'txt', 'png'] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={disabled}
                aria-busy={pendingFormat === format}
                className="min-h-11 rounded-md px-2 text-cafe-secondary hover:bg-cafe-surface-elevated disabled:opacity-40"
                onClick={() => onExport(format)}
              >
                {pendingFormat === format
                  ? t.exporting
                  : format === 'md'
                    ? t.document
                    : format === 'txt'
                      ? t.text
                      : t.image}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-l border-cafe pl-3">
            <button
              type="button"
              data-selection-primary="forward"
              disabled={disabled || forwardingDisabled || !onForward}
              title={forwardingDisabled ? t.admissionPending : !onForward ? t.forwardUnavailable : undefined}
              className="min-h-11 rounded-lg bg-cafe-accent px-3 font-semibold text-[var(--cafe-surface)] disabled:opacity-40"
              onClick={onForward}
            >
              {t.forward}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-md px-2 text-cafe-muted hover:text-cafe-primary"
              onClick={onCancel}
            >
              {t.cancel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
