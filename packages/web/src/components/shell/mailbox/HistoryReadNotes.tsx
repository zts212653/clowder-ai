import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { handledHistoryCopy } from './handled-history.shell-copy';
import type { HandledHistoryRead, HandledHistorySnapshot } from './handled-history-read';
import { historyReadState } from './history-read-state';

export function HistoryReadNotes({
  tab,
  snapshot,
  view,
  read,
  hasRows,
}: {
  tab: string;
  snapshot: HandledHistorySnapshot | null;
  view: UnifiedAttentionView;
  read: HandledHistoryRead;
  hasRows: boolean;
}) {
  const t = useShellCopy(handledHistoryCopy),
    language = useShellLanguage();
  const state = historyReadState(tab, snapshot, view);
  return (
    <>
      {state.reading ? (
        <p role="status" className="text-xs text-[var(--shell-muted)]">
          {hasRows ? t.updating : t.reading}
        </p>
      ) : null}
      {state.failed ? (
        <div
          role="status"
          className="mb-3 rounded-lg p-2 text-xs"
          style={{ background: 'var(--shell-frame)', color: 'var(--semantic-warning)' }}
        >
          {hasRows && state.observedAt !== null
            ? t.cached(
                new Date(state.observedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                }),
              )
            : t.unavailable}{' '}
          <button
            type="button"
            className="shell-focusable underline"
            onClick={() => {
              if (tab === 'all' || tab === 'decisions') void read.refresh();
              if (tab !== 'decisions') view.refetch();
            }}
          >
            {t.retry}
          </button>
        </div>
      ) : null}
    </>
  );
}
