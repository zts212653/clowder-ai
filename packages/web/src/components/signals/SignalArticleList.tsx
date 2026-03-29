import type { SignalArticle, SignalArticleStatus } from '@cat-cafe/shared';
import { SignalTierBadge } from './SignalTierBadge';

interface SignalArticleListProps {
  readonly items: readonly SignalArticle[];
  readonly selectedArticleId: string | null;
  readonly onSelect: (article: SignalArticle) => void;
  readonly onStatusChange: (articleId: string, status: SignalArticleStatus) => Promise<void>;
  readonly selectedIds?: ReadonlySet<string>;
  readonly onToggleSelect?: (articleId: string) => void;
}

const statusClassMap: Record<SignalArticleStatus, string> = {
  inbox: 'text-cocreator-dark bg-cocreator-bg',
  read: 'text-cafe-secondary bg-cafe-surface-elevated',
  archived: 'text-cafe-secondary bg-cafe-surface-elevated',
  starred: 'text-amber-800 bg-amber-100',
};

function formatDate(input: string): string {
  const value = Date.parse(input);
  if (Number.isNaN(value)) {
    return input;
  }
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SignalArticleList({
  items,
  selectedArticleId,
  onSelect,
  onStatusChange,
  selectedIds,
  onToggleSelect,
}: SignalArticleListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-cafe bg-cafe-surface p-8 text-center text-sm text-cafe-secondary">
        当前筛选条件下没有文章。
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((article) => {
        const selected = selectedArticleId === article.id;
        return (
          <li key={article.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(article)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(article);
                }
              }}
              className={[
                'w-full rounded-xl border bg-cafe-surface p-4 text-left shadow-sm transition-colors',
                selected
                  ? 'border-cocreator-primary ring-1 ring-cocreator-primary/40'
                  : 'border-cafe hover:border-cocreator-light',
              ].join(' ')}
            >
              <div className="flex items-start gap-3">
                {onToggleSelect && (
                  <input
                    type="checkbox"
                    checked={selectedIds?.has(article.id) ?? false}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleSelect(article.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1.5 shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-5 text-cafe-black">
                    {article.title}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <SignalTierBadge tier={article.tier} />
                    <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusClassMap[article.status]}`}>
                      {article.status}
                    </span>
                    <span className="text-xs text-cafe-muted">·</span>
                    <span className="text-xs text-cafe-secondary">{article.source}</span>
                    <span className="text-xs text-cafe-secondary">{formatDate(article.fetchedAt)}</span>
                    {article.note && (
                      <span title="有备注" className="text-opus-dark">
                        ✎
                      </span>
                    )}
                    {(article.studyCount ?? 0) > 0 && (
                      <span
                        title={`学习 ${article.studyCount} 次`}
                        className="rounded bg-opus-bg px-1 text-[10px] text-opus-dark"
                      >
                        学{article.studyCount}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1 pt-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onStatusChange(article.id, 'read');
                    }}
                    className="rounded-md border border-cafe px-2 py-1 text-xs text-cafe-secondary hover:border-codex-light hover:text-codex-dark"
                  >
                    已读
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onStatusChange(article.id, 'starred');
                    }}
                    className="rounded-md border border-amber-200 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
                  >
                    收藏
                  </button>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
