import type { AssetCollaborationAction, AssetCollaborationState } from './asset-collaboration-store';

interface AssetHistoryProps {
  state: AssetCollaborationState;
  dispatch: (action: AssetCollaborationAction) => void;
}

const ACTION_LABELS = {
  proposed: '提出建议',
  reviewed: '复查',
  annotated: '添加批注',
  discussed: '参与讨论',
  edited: '保存版本',
  accepted: '接受建议',
  disagreed: '保留分歧',
  versioned: '形成版本',
} as const;

export function AssetHistory({ state, dispatch }: AssetHistoryProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="产物历程">
      <header className="border-b border-cafe-subtle px-4 py-3.5">
        <h2 className="text-xs font-semibold text-cafe-black">这个版本怎样走到今天</h2>
        <p className="mt-1 text-micro leading-5 text-cafe-muted">点击一项，回到它产生的原文、对话或版本。</p>
      </header>

      <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {[...state.history].reverse().map((entry, index) => {
          const active = entry.id === state.ui.selectedHistoryId;
          return (
            <li key={entry.id} className="relative pl-5" data-history-entry>
              {index < state.history.length - 1 && (
                <span className="absolute bottom-0 left-[7px] top-4 w-px bg-cafe-border-subtle" aria-hidden="true" />
              )}
              <span
                className={`absolute left-1 top-4 h-2 w-2 rounded-full ring-4 ring-cafe-surface-elevated ${
                  active ? 'bg-cafe-interactive' : 'bg-cafe-muted/55'
                }`}
                aria-hidden="true"
              />
              <button
                type="button"
                data-history-action={entry.action}
                data-history-target-kind={entry.target.kind}
                onClick={() => dispatch({ type: 'open_history_target', historyId: entry.id })}
                className={`mb-1.5 w-full rounded-lg px-2.5 py-2 text-left ${
                  active ? 'bg-cafe-surface shadow-sm ring-1 ring-cafe-border' : 'hover:bg-cafe-surface/70'
                }`}
              >
                <span className="flex items-center gap-2 text-micro">
                  <span className="font-semibold text-cafe-secondary">{entry.actor}</span>
                  <span className="text-cafe-muted">{entry.createdAt.slice(5, 16).replace('T', ' ')}</span>
                  <span className="ml-auto rounded-full bg-cafe-surface-sunken px-1.5 py-0.5 font-medium text-cafe-secondary">
                    {ACTION_LABELS[entry.action]}
                  </span>
                </span>
                <span className="mt-1 block text-xs font-medium leading-5 text-cafe-black">{entry.summary}</span>
                {entry.detail && (
                  <span className="mt-1 block text-micro leading-5 text-cafe-muted">{entry.detail}</span>
                )}
              </button>
              {entry.sourceUrl && (
                <a
                  href={entry.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-2.5 ml-2 inline-flex text-micro font-medium text-cafe-interactive hover:underline"
                >
                  查看来源
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
