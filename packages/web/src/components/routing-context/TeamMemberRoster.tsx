'use client';

import type { RoutingContextReadModelV1, RoutingContextSnapshotV1 } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';
import { RoutingPreferenceControls } from './RoutingPreferenceControls';
import { preferenceHeads } from './routing-context-commands';
import { AvailabilityBadge } from './TeamCandidatePresentation';
import styles from './TeamWorkspacePanel.module.css';
import {
  countTeamMembers,
  filterTeamMembers,
  type TeamMemberFilter,
  type TeamMemberRow,
} from './team-member-projection';

type Candidate = RoutingContextSnapshotV1['candidates'][number];

const FILTER_LABELS: { id: TeamMemberFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'attention', label: '暂需留意' },
  { id: 'absent', label: '资料待补' },
];

function MemberRow({ row, onSelect }: { row: TeamMemberRow; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`${styles.memberRow} w-full border-b border-cafe-subtle/60 p-3 text-left transition-colors last:border-b-0 hover:bg-cafe-surface`}
      data-testid={`team-cat-${row.identity.catId}`}
      aria-label={`查看 ${row.identity.displayName}`}
    >
      <CatAvatar catId={row.identity.catId} size={40} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <strong className="text-sm font-semibold text-cafe-black">{row.identity.displayName}</strong>
          {row.identity.secondaryLabel && (
            <small className="text-micro text-cafe-muted">{row.identity.secondaryLabel}</small>
          )}
        </span>
        <span
          className={`mt-0.5 block text-xs leading-5 ${row.capability.state === 'applied' ? 'text-cafe-secondary' : 'text-cafe-muted'}`}
        >
          {row.capability.summary}
        </span>
      </span>
      <AvailabilityBadge reading={row.availability} />
    </button>
  );
}

function ProviderFold({
  providers,
  onSubjectChange,
}: {
  providers: Map<string, Candidate[]>;
  onSubjectChange: (subject: TeamWorkspaceSubject) => void;
}) {
  return (
    <details className="mt-6 border-t border-cafe-subtle pt-3 text-micro text-cafe-secondary">
      <summary className="cursor-pointer font-semibold">按运行服务查看</summary>
      <div className="mt-2 space-y-2">
        {[...providers].map(([providerId, cats]) => {
          const blocked = cats.filter((candidate) => candidate.effect === 'blocked').length;
          const unknown = cats.filter((candidate) => candidate.availability === 'unknown').length;
          const advisory = cats.filter(
            (candidate) => candidate.availability === 'scarce' || candidate.availability === 'degraded',
          ).length;
          const status =
            [
              blocked > 0 ? `${blocked} 位阻塞` : '',
              advisory > 0 ? `${advisory} 位需关注` : '',
              unknown > 0 ? `${unknown} 位状态未知` : '',
            ]
              .filter(Boolean)
              .join(' · ') || '运行中';
          return (
            <button
              key={providerId}
              type="button"
              onClick={() => onSubjectChange({ type: 'provider', id: providerId })}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-cafe-subtle/75 p-3 text-left transition-colors hover:bg-cafe-surface"
              data-testid={`team-provider-${providerId}`}
            >
              <span>
                <span className="block text-xs font-semibold text-cafe-black">{providerId}</span>
                <span className="mt-0.5 block text-micro text-cafe-muted">{cats.length} 位成员使用此服务</span>
              </span>
              <span className="text-micro font-semibold text-cafe-secondary">{status}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}

export function TeamMemberRoster({
  rows,
  providers,
  model,
  query,
  filter,
  preferencesOpen,
  onQueryChange,
  onFilterChange,
  onPreferencesToggle,
  onClearFilters,
  onSubjectChange,
  onChanged,
}: {
  rows: readonly TeamMemberRow[];
  providers: Map<string, Candidate[]>;
  model: RoutingContextReadModelV1;
  query: string;
  filter: TeamMemberFilter;
  preferencesOpen: boolean;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: TeamMemberFilter) => void;
  onPreferencesToggle: () => void;
  onClearFilters: () => void;
  onSubjectChange: (subject: TeamWorkspaceSubject) => void;
  onChanged: () => Promise<boolean>;
}) {
  const counts = countTeamMembers(rows);
  // One rule with three stored revisions is still one rule (AC-UX3).
  const ruleCount = preferenceHeads(model.preferenceRevisions).length;
  const visible = filterTeamMembers(rows, { query, filter });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-cafe-black">一起工作的伙伴</h2>
          <p className="mt-1 text-xs text-cafe-secondary">了解每只猫的长处，以及现在找他时需要留意的事。</p>
        </div>
        <button
          type="button"
          onClick={onPreferencesToggle}
          aria-expanded={preferencesOpen}
          className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface"
          data-testid="team-preferences-toggle"
        >
          协作偏好 {ruleCount > 0 ? ruleCount : ''}
        </button>
      </div>
      {preferencesOpen && <RoutingPreferenceControls revisions={model.preferenceRevisions} onChanged={onChanged} />}
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索猫猫或擅长的事"
        aria-label="搜索猫猫或擅长的事"
        className="h-10 w-full rounded-xl border border-cafe-subtle bg-cafe-surface px-3 text-sm text-cafe-black"
        data-testid="team-member-search"
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label="成员筛选">
        {FILTER_LABELS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onFilterChange(id)}
            aria-pressed={filter === id}
            className={`rounded-full border px-3 py-1 text-micro font-semibold transition-colors ${
              filter === id
                ? 'border-cafe-accent/40 bg-cafe-surface-sunken text-cafe-black'
                : 'border-cafe-subtle text-cafe-secondary hover:bg-cafe-surface'
            }`}
            data-testid={`team-filter-${id}`}
          >
            {label} <span className="text-cafe-muted">{counts[id]}</span>
          </button>
        ))}
      </div>
      <section data-testid="team-members-section">
        <div
          className="overflow-hidden rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)]"
          data-team-layout="container-driven"
        >
          {visible.map((row) => (
            <MemberRow
              key={row.identity.catId}
              row={row}
              onSelect={() => onSubjectChange({ type: 'cat', id: row.identity.catId })}
            />
          ))}
          {visible.length === 0 &&
            (rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-cafe-secondary" data-testid="team-roster-empty">
                当前目录还没有可展示的团队成员
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-xs text-cafe-secondary" data-testid="team-search-empty">
                <p>没有找到符合条件的成员</p>
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="mt-2 font-semibold text-cafe-accent hover:underline"
                  data-testid="team-clear-filters"
                >
                  清除筛选
                </button>
              </div>
            ))}
        </div>
      </section>
      <ProviderFold providers={providers} onSubjectChange={onSubjectChange} />
    </div>
  );
}
