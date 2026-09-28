'use client';

import type { RoutingContextReadModelV1, RoutingContextSnapshotV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useCatData } from '@/hooks/useCatData';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';
import type { DegradedRoutingContextReadModel } from './DegradedTeamView';
import { DegradedTeamView } from './DegradedTeamView';
import { RoutingSignalControls } from './RoutingSignalControls';
import { AvailabilityBadge } from './TeamCandidatePresentation';
import { TeamMemberDetail } from './TeamMemberDetail';
import { TeamMemberRoster } from './TeamMemberRoster';
import { TeamStaleReadNotice } from './TeamStaleReadNotice';
import styles from './TeamWorkspacePanel.module.css';
import { readTeamAvailability, type TeamMemberRow, toTeamMemberRow } from './team-member-projection';
import { resolveTeamWorkspaceSubject } from './team-navigation';
import { DEFAULT_TEAM_READING, readTeamReading, useTeamReading } from './team-reading-state';
import { useRoutingContext } from './useRoutingContext';

type Candidate = RoutingContextSnapshotV1['candidates'][number];

/**
 * Scrolling is a hot path. Persisting every scroll event would write localStorage
 * and re-render the roster on each frame, so positions are buffered and committed
 * once the reader settles — or immediately when they navigate away.
 */
const SCROLL_FLUSH_MS = 200;

function ProviderDetail({
  providerId,
  candidates,
  rows,
  model,
  onChanged,
}: {
  providerId: string;
  candidates: Candidate[];
  rows: readonly TeamMemberRow[];
  model: RoutingContextReadModelV1;
  onChanged: () => Promise<boolean>;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-cafe-black">{providerId}</h3>
        <p className="text-xs text-cafe-muted">{candidates.length} 位成员使用此服务</p>
      </div>
      {candidates.map((candidate) => {
        const row = rows.find((item) => item.identity.catId === candidate.binding.catId);
        return (
          <div
            key={candidate.binding.catId}
            className="flex items-center justify-between gap-3 rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5"
          >
            <span className="text-sm font-semibold text-cafe-black">
              {row?.identity.displayName ?? candidate.binding.catId}
            </span>
            <AvailabilityBadge reading={row?.availability ?? readTeamAvailability(candidate.availability)} />
          </div>
        );
      })}
      <RoutingSignalControls
        subjectRef={{ type: 'provider', providerId }}
        affectedCatIds={candidates.map((candidate) => candidate.binding.catId)}
        signalEvents={model.signalEvents}
        onChanged={onChanged}
      />
    </div>
  );
}

function TeamWorkspaceBody({
  data,
  loading,
  error,
  ownerKey,
  resolvedSubject,
  onSubjectChange,
  refresh,
}: {
  data: RoutingContextReadModelV1 | null;
  loading: boolean;
  error: string | null;
  ownerKey: string;
  resolvedSubject: TeamWorkspaceSubject | null;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
  refresh: () => Promise<boolean>;
}) {
  const { getCatById } = useCatData({ fetch: false });
  const reading = useTeamReading((state) => state.readings[ownerKey]) ?? DEFAULT_TEAM_READING;
  const updateReading = useTeamReading((state) => state.update);

  const candidates = useMemo(
    () => (data?.resolution.state === 'fresh' ? data.resolution.snapshot.candidates : []),
    [data],
  );
  const rows = useMemo(
    () => candidates.map((candidate) => toTeamMemberRow(candidate, getCatById(candidate.binding.catId))),
    [candidates, getCatById],
  );
  const providers = useMemo(() => {
    const grouped = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const group = grouped.get(candidate.binding.providerId) ?? [];
      group.push(candidate);
      grouped.set(candidate.binding.providerId, group);
    }
    return grouped;
  }, [candidates]);

  if (loading && !data) {
    return (
      <div className="space-y-2" data-testid="team-loading">
        <div className="h-20 animate-pulse rounded-xl bg-cafe-surface-sunken" />
        <div className="h-20 animate-pulse rounded-xl bg-cafe-surface-sunken" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="rounded-xl border border-conn-red-ring bg-conn-red-bg p-4 text-sm text-conn-red-text">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 font-semibold underline"
          data-testid="team-retry"
        >
          重新读取
        </button>
      </div>
    );
  }
  if (!data) return null;
  if (data.resolution.state === 'degraded') {
    return (
      <DegradedTeamView
        getCatById={getCatById}
        model={data as DegradedRoutingContextReadModel}
        subject={resolvedSubject}
        onSubjectChange={onSubjectChange}
        onChanged={refresh}
      />
    );
  }
  if (resolvedSubject?.type === 'cat') {
    const row = rows.find((item) => item.identity.catId === resolvedSubject.id);
    return row ? <TeamMemberDetail row={row} model={data} onChanged={refresh} /> : null;
  }
  if (resolvedSubject?.type === 'provider') {
    return (
      <ProviderDetail
        providerId={resolvedSubject.id}
        candidates={providers.get(resolvedSubject.id) ?? []}
        rows={rows}
        model={data}
        onChanged={refresh}
      />
    );
  }
  return (
    <TeamMemberRoster
      rows={rows}
      providers={providers}
      model={data}
      query={reading.query}
      filter={reading.filter}
      preferencesOpen={reading.preferencesOpen}
      onQueryChange={(query) => updateReading(ownerKey, { query })}
      onFilterChange={(filter) => updateReading(ownerKey, { filter })}
      onPreferencesToggle={() => updateReading(ownerKey, { preferencesOpen: !reading.preferencesOpen })}
      onClearFilters={() => updateReading(ownerKey, { query: '', filter: 'all' })}
      onSubjectChange={onSubjectChange}
      onChanged={refresh}
    />
  );
}

export function TeamWorkspacePanel({
  subject,
  onSubjectChange,
  ownerKey = 'global',
}: {
  subject: TeamWorkspaceSubject | null;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
  /** F307 owner-state key, so one thread's reading posture never leaks into another. */
  ownerKey?: string;
}) {
  const { data, loading, error, refresh } = useRoutingContext();
  const resolvedSubject = useMemo(() => (data ? resolveTeamWorkspaceSubject(subject, data) : subject), [data, subject]);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showingRoster = !resolvedSubject && data !== null;

  useEffect(() => {
    if (data?.resolution.state === 'fresh' && subject && !resolvedSubject) onSubjectChange(null);
  }, [data, onSubjectChange, resolvedSubject, subject]);

  const flushScroll = useCallback(() => {
    if (flushTimer.current !== undefined) {
      clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
    }
    const top = pendingScroll.current;
    pendingScroll.current = null;
    if (top === null || readTeamReading(ownerKey).scroll === top) return;
    useTeamReading.getState().update(ownerKey, { scroll: top });
  }, [ownerKey]);

  // Replay the saved position every time the roster comes back — a member detail and
  // a fold both leave it, and both must return the reader where they were.
  useLayoutEffect(() => {
    if (!showingRoster || !viewport.current) return;
    viewport.current.scrollTop = readTeamReading(ownerKey).scroll;
  }, [showingRoster, ownerKey]);

  /**
   * Leaving the roster (member detail, fold, unmount) commits the last buffered
   * position immediately, so a reader who scrolls and navigates within the debounce
   * window still comes back to where they were.
   *
   * `showingRoster` is read in the body on purpose: it is what scopes the cleanup to
   * an actual roster departure. Written as a bare `useEffect(() => flushScroll, ...)`
   * the linter reports it as a redundant dependency, and removing it would silently
   * restore the race this guards.
   */
  useEffect(() => {
    if (!showingRoster) return;
    return () => flushScroll();
  }, [showingRoster, flushScroll]);

  return (
    <div
      ref={viewport}
      onScroll={(event) => {
        if (!showingRoster) return;
        pendingScroll.current = event.currentTarget.scrollTop;
        if (flushTimer.current !== undefined) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flushScroll, SCROLL_FLUSH_MS);
      }}
      className={`${styles.root} min-h-0 flex-1 overflow-y-auto`}
      data-testid="team-workspace-panel"
    >
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-5">
        {resolvedSubject && (
          <button
            type="button"
            onClick={() => onSubjectChange(null)}
            className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-cafe-accent hover:underline"
            data-testid="team-detail-back"
          >
            <span aria-hidden="true">←</span> 返回成员
          </button>
        )}
        {data && error && <TeamStaleReadNotice error={error} onRetry={() => void refresh()} />}
        <TeamWorkspaceBody
          data={data}
          loading={loading}
          error={error}
          ownerKey={ownerKey}
          resolvedSubject={resolvedSubject}
          onSubjectChange={onSubjectChange}
          refresh={refresh}
        />
      </div>
    </div>
  );
}
