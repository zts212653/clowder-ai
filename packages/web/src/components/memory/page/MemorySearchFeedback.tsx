import { type MemorySearchGroup, SEARCH_LABELS } from './memory-search-types';

export function MemorySearchFeedback({ groups, retry }: { groups: MemorySearchGroup[]; retry: () => void }) {
  const empty = groups.filter((g) => g.status === 'ready' && g.results.length === 0);
  const partialEmpty = groups.filter((g) => g.status === 'partial' && g.results.length === 0);
  return (
    <>
      {empty.length > 0 && (
        <p className="text-sm text-cafe-muted">{empty.map((g) => SEARCH_LABELS[g.type]).join('、')}里没有找到匹配。</p>
      )}
      {partialEmpty.length > 0 && (
        <p className="text-sm text-cafe-muted">
          本次核对的{partialEmpty.map((g) => SEARCH_LABELS[g.type]).join('、')}里没有找到匹配。
        </p>
      )}
      {groups.map((group) => (
        <div key={group.type}>
          {group.status === 'unavailable' && (
            <p className="text-compact text-cafe-muted">
              {SEARCH_LABELS[group.type]}暂时读不到{' '}
              <button type="button" onClick={retry} className="ml-2 text-cafe-accent underline">
                重试
              </button>
            </p>
          )}
          {group.status === 'partial' && (
            <p className="text-compact text-cafe-muted">
              {SEARCH_LABELS[group.type]}仅部分可核对
              {group.type === 'conversations' ? ' · 对话索引的覆盖范围尚未确认' : ''}
            </p>
          )}
        </div>
      ))}
      {groups.some((g) => g.degraded) && (
        <p className="text-compact text-cafe-muted">按意思检索仅部分可用；保留已核对的结果。</p>
      )}
      {groups.some((g) => g.status !== 'unavailable' && g.hasMore) && (
        <p className="text-compact text-cafe-muted">还有更多匹配；请缩小搜索词。</p>
      )}
    </>
  );
}
