import { SYNC_ICON } from '@/components/community-panel-icons';

const ISSUE_SECTION_OPTIONS = [
  { key: 'unreplied', label: '未回复' },
  { key: 'discussing', label: '讨论中' },
  { key: 'pending-decision', label: '待决策' },
  { key: 'accepted', label: '已接受' },
  { key: 'declined', label: '已拒绝' },
  { key: 'closed', label: '已关闭' },
] as const;

const TIME_RANGE_OPTIONS = [
  { key: 'all', label: '全部时间' },
  { key: '7d', label: '7 天内' },
  { key: '30d', label: '30 天内' },
  { key: '90d', label: '90 天内' },
] as const;

export const TIME_RANGES: Record<string, number> = {
  '7d': 7 * 86400000,
  '30d': 30 * 86400000,
  '90d': 90 * 86400000,
};

interface CommunityPanelFiltersProps {
  repos: string[];
  repo: string;
  onRepoChange: (repo: string) => void;
  stateFilter: string;
  onStateFilterChange: (v: string) => void;
  catFilter: string;
  onCatFilterChange: (v: string) => void;
  timeRange: string;
  onTimeRangeChange: (v: string) => void;
  uniqueCats: string[];
  loading: boolean;
  onSync: () => void;
}

const selectClass =
  'text-[10px] bg-cafe-surface rounded px-1.5 py-0.5 border border-cocreator-light/30 text-cafe-secondary';

export function CommunityPanelFilters({
  repos,
  repo,
  onRepoChange,
  stateFilter,
  onStateFilterChange,
  catFilter,
  onCatFilterChange,
  timeRange,
  onTimeRangeChange,
  uniqueCats,
  loading,
  onSync,
}: CommunityPanelFiltersProps) {
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-cocreator-light/40">
        <select
          data-testid="repo-filter"
          value={repo}
          onChange={(e) => onRepoChange(e.target.value)}
          className="flex-1 text-xs bg-cafe-surface rounded px-2 py-1 border border-cocreator-light/30 text-cafe-secondary"
        >
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onSync}
          disabled={loading}
          className="flex items-center gap-1 text-[10px] text-cocreator-dark/60 hover:text-cocreator-dark transition-colors disabled:opacity-50"
          title="手动同步"
        >
          <span className={loading ? 'animate-spin' : ''}>{SYNC_ICON}</span>
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-cocreator-light/20">
        <select
          data-testid="issue-state-filter"
          value={stateFilter}
          onChange={(e) => onStateFilterChange(e.target.value)}
          className={selectClass}
        >
          <option value="all">全部状态</option>
          {ISSUE_SECTION_OPTIONS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          data-testid="cat-filter"
          value={catFilter}
          onChange={(e) => onCatFilterChange(e.target.value)}
          className={selectClass}
        >
          <option value="all">全部负责猫</option>
          {uniqueCats.map((c) => (
            <option key={c} value={c}>
              @{c}
            </option>
          ))}
        </select>
        <select
          data-testid="time-range-filter"
          value={timeRange}
          onChange={(e) => onTimeRangeChange(e.target.value)}
          className={selectClass}
        >
          {TIME_RANGE_OPTIONS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
