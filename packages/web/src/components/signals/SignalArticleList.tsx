import type { SignalArticle, SignalArticleStatus } from '@cat-cafe/shared';
import { SignalTierBadge } from './SignalTierBadge';

interface SignalArticleListProps {
  readonly items: readonly SignalArticle[];
  readonly selectedArticleId: string | null;
  readonly onSelect: (article: SignalArticle) => void;
  readonly onStatusChange?: (articleId: string, status: SignalArticleStatus) => void;
  readonly selectedIds?: ReadonlySet<string>;
  readonly onToggleSelect?: (articleId: string) => void;
}

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
      <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--console-card-bg)] px-8 py-16 text-center">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="mb-3 h-10 w-10 text-cafe-muted opacity-40"
        >
          <path
            d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line x1="4" y1="22" x2="4" y2="15" strokeLinecap="round" />
        </svg>
        <p className="text-[14px] font-semibold text-cafe">当前筛选条件下没有文章</p>
        <p className="mt-1 text-xs text-cafe-muted">尝试调整筛选条件或等待新信号</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((article) => {
        const selected = selectedArticleId === article.id;
        const initial = (article.source?.[0] ?? '?').toUpperCase();
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
                'flex items-center gap-3 rounded-[14px] px-3 py-2.5 cursor-pointer transition-all',
                selected
                  ? 'bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)]'
                  : 'hover:bg-[var(--console-card-bg)]/60',
              ].join(' ')}
              style={{ minHeight: 76 }}
            >
              {onToggleSelect && (
                <input
                  type="checkbox"
                  checked={selectedIds?.has(article.id) ?? false}
                  onChange={(e) => {
                    e.stopPropagation();
                    onToggleSelect(article.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0"
                />
              )}
              <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--console-card-bg)] text-xs font-semibold text-cafe-secondary">
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[13px] font-semibold leading-[1.35] text-cafe">{article.title}</p>
                <p className="mt-1 text-[11px] text-cafe-secondary">
                  {article.source} · {formatDate(article.fetchedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <SignalTierBadge tier={article.tier} />
                {onStatusChange && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onStatusChange(article.id, 'read');
                      }}
                      className="rounded-md bg-[var(--console-card-bg)] px-2 py-1 text-[10px] font-semibold text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] transition hover:text-cafe"
                    >
                      已读
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onStatusChange(article.id, 'starred');
                      }}
                      className="rounded-md bg-conn-amber-bg px-2 py-1 text-[10px] font-semibold text-conn-amber-text transition hover:opacity-80"
                    >
                      收藏
                    </button>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
