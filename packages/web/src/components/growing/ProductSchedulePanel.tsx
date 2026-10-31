'use client';

import type { ArtifactReviewView, EntrustedWorkOwnerReadV1, IgnoredItemCoordinate } from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';
import { useIgnoredItemPreferences } from '@/hooks/useIgnoredItemPreferences';
import { scheduleCopy } from './product-schedule.shell-copy';
import { SchedulePanelControls } from './SchedulePanelControls';
import { ScheduleWorkCard } from './ScheduleWorkCard';
import { ScheduleWorkGroups } from './ScheduleWorkGroups';
import { WorkCalendarView } from './WorkCalendarView';
import { calendarDateKey, currentScheduleWorks, workCalendarDates, workDates } from './work-calendar';
import styles from './work-schedule.module.css';

export type PreparedArtifactCoordinate = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;
export function scheduleItemRef(work: EntrustedWorkOwnerReadV1): string {
  // This is a Workspace return coordinate, not a new Task identity.
  return `${work.envelope.subjectRef}|${work.envelope.revision}${work.completion ? '|completed' : ''}`;
}
type WorkFilter = 'all' | 'doing' | 'blocked' | 'todo';

export function ProductSchedulePanel({
  onOpenArtifact,
  artifactsLoading = false,
  onOpenReview,
  selectedItemRef,
  now = Date.now,
}: {
  onOpenArtifact?: (artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void;
  artifactsLoading?: boolean;
  onOpenReview?: (review: ArtifactReviewView, itemRef: string) => void;
  selectedItemRef?: string | null;
  now?: () => number;
}) {
  const t = useShellCopy(scheduleCopy);
  const active = useEntrustedWorkProjection('schedule');
  const completed = useEntrustedWorkProjection('completed');
  const preferences = useIgnoredItemPreferences();
  const [showIgnored, setShowIgnored] = useState(false);
  const [lastIgnored, setLastIgnored] = useState<{ ownerUserId: string; coordinate: IgnoredItemCoordinate } | null>(
    null,
  );
  const [scope, setScope] = useState<'active' | 'completed'>(() =>
    selectedItemRef?.endsWith('|completed') ? 'completed' : 'active',
  );
  const [wide, setWide] = useState(false);
  const [calendarView, setCalendarView] = useState<'week' | 'month'>('week');
  const [month, setMonth] = useState(() => now());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkFilter>('all');
  const selectedRef = useRef<HTMLElement | null>(null);
  const locatedSelectionRef = useRef<string | null | undefined>(undefined);
  const workScrollRef = useRef<HTMLDivElement | null>(null);
  const recentScrollRef = useRef<HTMLElement | null>(null);
  const localReadingRef = useRef<{
    itemRef: string;
    port: HTMLElement;
    top: number;
    width: number;
    movedAside: boolean;
    requestStarted: boolean;
  } | null>(null);
  const rememberLocalOpen = (itemRef: string, fromRecent: boolean) => {
    const port = fromRecent ? recentScrollRef.current : workScrollRef.current;
    localReadingRef.current = port
      ? { itemRef, port, top: port.scrollTop, width: port.clientWidth, movedAside: false, requestStarted: false }
      : null;
  };
  const currentTime = now();
  const works = useMemo(() => currentScheduleWorks(active.ownerReads), [active.ownerReads]);
  const completedWorks = useMemo(
    () =>
      currentScheduleWorks(completed.ownerReads).sort(
        (a, b) => (b.completion?.recordedAt ?? 0) - (a.completion?.recordedAt ?? 0),
      ),
    [completed.ownerReads],
  );
  const recent = completedWorks.filter(
    (work) =>
      work.completion?.recordedAt !== undefined &&
      work.completion.recordedAt <= currentTime &&
      work.completion.recordedAt >= currentTime - 7 * 86400000,
  );
  const projection = scope === 'completed' ? completed : active;
  const source = scope === 'completed' ? completedWorks : works;
  const partial = projection.partial;
  const ignoreCoordinate = (work: EntrustedWorkOwnerReadV1): IgnoredItemCoordinate => ({
    kind: 'schedule',
    subjectRef: work.envelope.subjectRef,
  });
  const ignored = (work: EntrustedWorkOwnerReadV1) => preferences.isIgnored(ignoreCoordinate(work));
  const ownerConfirmed =
    preferences.ready &&
    source.every((work) => work.envelope.visibility.ownerUserId === preferences.snapshot?.ownerUserId);
  const ignoredCount = ownerConfirmed ? works.filter(ignored).length : null;
  const undoCoordinate =
    ownerConfirmed && lastIgnored?.ownerUserId === preferences.snapshot?.ownerUserId ? lastIgnored?.coordinate : null;
  const shownWorks =
    scope === 'completed' || !ownerConfirmed
      ? source
      : source.filter((work) => (showIgnored ? ignored(work) : !ignored(work)));
  const overdue = works.filter((work) =>
    workDates(work).some((time) => time.role === 'business_deadline' && time.value < currentTime),
  );
  const visible = shownWorks.filter((work) => {
    if (scheduleItemRef(work) === selectedItemRef) return true;
    if (scope === 'completed' || showIgnored) return true;
    if (filter !== 'all' && work.brief.current.state !== filter) return false;
    if (wide) return true;
    const dates = workCalendarDates(work);
    return (
      dates.length === 0 || (selectedDay !== null && dates.some((time) => calendarDateKey(time.value) === selectedDay))
    );
  });
  useEffect(() => {
    if (selectedItemRef?.endsWith('|completed') && selectedItemRef !== localReadingRef.current?.itemRef)
      setScope('completed');
  }, [selectedItemRef]);
  useLayoutEffect(() => {
    if (localReadingRef.current && artifactsLoading) localReadingRef.current.requestStarted = true;
    if (projection.loading) return;
    if (selectedItemRef !== localReadingRef.current?.itemRef && !artifactsLoading) {
      localReadingRef.current = null;
      if (selectedItemRef && selectedItemRef !== locatedSelectionRef.current)
        selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
    if (!artifactsLoading && (!selectedItemRef || selectedRef.current)) locatedSelectionRef.current = selectedItemRef;
    const port = localReadingRef.current?.port ?? workScrollRef.current;
    if (!port) return;
    const restoreReading = () => {
      const reading = localReadingRef.current;
      if (!reading || reading.itemRef !== selectedItemRef) return;
      if (port.closest('[role="complementary"]')) reading.movedAside = true;
      else if (reading.movedAside) {
        if (port.clientWidth === reading.width) port.scrollTop = reading.top;
        localReadingRef.current = null;
      } else if (reading.requestStarted && !artifactsLoading) localReadingRef.current = null;
    };
    restoreReading();
    const observer = new ResizeObserver(restoreReading);
    observer.observe(port);
    return () => observer.disconnect();
  }, [selectedItemRef, projection.loading, artifactsLoading, scope]);
  const renderWork = (work: EntrustedWorkOwnerReadV1, fromRecent = false) => {
    const itemRef = scheduleItemRef(work);
    return (
      <ScheduleWorkCard
        key={itemRef}
        ownerRead={work}
        currentTime={currentTime}
        itemRef={itemRef}
        selected={selectedItemRef === itemRef}
        dateSelected={
          selectedDay !== null && workCalendarDates(work).some((time) => calendarDateKey(time.value) === selectedDay)
        }
        selectedRef={selectedItemRef === itemRef ? selectedRef : undefined}
        artifactsLoading={artifactsLoading}
        personal={
          scope === 'active'
            ? {
                ignored: ownerConfirmed && ignored(work),
                disabled: !ownerConfirmed || preferences.saving || partial,
                onChange: (ignore) => {
                  const coordinate = ignoreCoordinate(work);
                  const ownerUserId = preferences.snapshot?.ownerUserId;
                  void preferences.change(ignore ? [coordinate] : [], ignore ? [] : [coordinate]).then((saved) => {
                    if (saved && ownerUserId) setLastIgnored(ignore ? { ownerUserId, coordinate } : null);
                  });
                },
              }
            : undefined
        }
        onOpenArtifact={
          onOpenArtifact
            ? (artifact, itemRef, title) => {
                rememberLocalOpen(itemRef, fromRecent);
                onOpenArtifact(artifact, itemRef, title);
              }
            : undefined
        }
        onOpenReview={
          onOpenReview
            ? (review, itemRef) => {
                rememberLocalOpen(itemRef, fromRecent);
                onOpenReview(review, itemRef);
              }
            : undefined
        }
      />
    );
  };
  return (
    <section
      className={`${styles.panel} min-w-0 overflow-x-hidden p-4 sm:p-5`}
      data-testid="product-schedule-panel"
      aria-label={t.title}
    >
      <SchedulePanelControls
        scope={scope}
        showIgnored={showIgnored}
        disabled={!ownerConfirmed || preferences.saving}
        error={preferences.error}
        hasUndo={undoCoordinate != null}
        onRefresh={() => {
          active.refetch();
          completed.refetch();
          void preferences.refetch();
        }}
        onScope={(value) => {
          setScope(value);
          setShowIgnored(false);
          setFilter('all');
          setSelectedDay(null);
        }}
        onIgnored={() => setShowIgnored(!showIgnored)}
        onUndo={() => {
          if (undoCoordinate)
            void preferences.change([], [undoCoordinate]).then((saved) => {
              if (saved) setLastIgnored(null);
            });
        }}
        onDismissUndo={() => setLastIgnored(null)}
      />
      {projection.loading ? <p className="py-6 text-sm text-cafe-muted">{t.loading}</p> : null}
      {projection.error ? (
        <p role="status" className="rounded-xl border border-semantic-critical p-4 text-sm text-cafe-secondary">
          {t.unavailable}
        </p>
      ) : null}
      {!projection.loading && !projection.error ? (
        <>
          {scope === 'active' && ownerConfirmed && !partial && ignoredCount !== null ? (
            <p data-testid="schedule-personal-counts" className="mb-3 text-xs text-cafe-secondary">
              {t.personalCounts(works.length, visible.length, ignoredCount)}
            </p>
          ) : null}
          {partial ? (
            <p role="status" className="mb-3 text-sm text-cafe-muted">
              {t.partial}
            </p>
          ) : scope === 'active' ? (
            <p data-testid="schedule-work-summary" className="mb-3 text-sm text-cafe-secondary">
              {t.summary(
                works.filter((w) => w.brief.current.state === 'doing').length,
                works.filter((w) => w.brief.current.state === 'blocked').length,
                works.filter((w) => w.brief.current.state === 'todo').length,
              )}
              {overdue.length > 0 ? `；${t.overdueSubset(overdue.length)}` : ''}
            </p>
          ) : null}
          {scope === 'active' && !showIgnored && overdue.some((work) => !ownerConfirmed || !ignored(work)) ? (
            <details
              data-testid="schedule-overdue"
              className="mb-4 rounded-lg border border-cafe-subtle px-3 py-2 text-sm text-semantic-critical"
            >
              <summary className="cursor-pointer">{t.overdue(overdue.length)}</summary>
              <div className="mt-3 grid gap-3">
                {overdue
                  .filter((work) => !visible.includes(work) && (!ownerConfirmed || !ignored(work)))
                  .map((work) => renderWork(work))}
              </div>
            </details>
          ) : null}
          <div className={wide || scope === 'completed' ? styles.wideLayout : styles.layout}>
            {!wide && !showIgnored && scope === 'active' ? (
              <WorkCalendarView
                works={ownerConfirmed ? works.filter((work) => !ignored(work)) : works}
                month={month}
                today={currentTime}
                selectedDay={selectedDay}
                onMonth={setMonth}
                onDay={setSelectedDay}
                overdue={overdue.length}
                view={calendarView}
                onView={setCalendarView}
              />
            ) : null}
            <div className={styles.worklist} data-testid="schedule-worklist">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <h3 className="font-semibold text-cafe-secondary">
                  {showIgnored
                    ? t.ignored
                    : scope === 'completed'
                      ? t.completed
                      : wide
                        ? t.active
                        : selectedDay
                          ? t.day(selectedDay)
                          : t.unscheduled}{' '}
                  · {visible.length}
                </h3>
                {scope === 'active' ? (
                  <button type="button" className="text-cafe-accent" onClick={() => setWide(!wide)}>
                    {wide ? t.returnList : t.wide}
                  </button>
                ) : null}
                {selectedDay ? (
                  <button type="button" className="text-cafe-accent" onClick={() => setSelectedDay(null)}>
                    {t.allWork}
                  </button>
                ) : null}
              </div>
              {scope === 'active' && wide ? (
                <fieldset className="mb-3 flex flex-wrap gap-1.5" aria-label={t.filters}>
                  {(['all', 'blocked', 'doing', 'todo'] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                      className={`rounded-full px-3 py-1.5 text-xs ${filter === value ? 'bg-cafe-accent/10 text-cafe-accent' : 'bg-cafe-surface text-cafe-secondary'}`}
                    >
                      {value === 'all' ? t.all : t.status[value]}
                    </button>
                  ))}
                </fieldset>
              ) : null}
              <ScheduleWorkGroups
                scrollRef={workScrollRef}
                works={visible}
                hasWork={source.length > 0}
                partial={partial}
                completed={scope === 'completed'}
                renderWork={(work) => renderWork(work)}
              />
              {scope === 'active' && !showIgnored ? (
                <section ref={recentScrollRef} data-testid="schedule-recent-completed" className={styles.recent}>
                  <h3 className="mb-3 text-sm font-semibold text-cafe-secondary">{t.recent}</h3>
                  {completed.loading ? (
                    <p className="text-xs text-cafe-muted">{t.loading}</p>
                  ) : completed.error ? (
                    <p role="status" className="text-xs text-cafe-muted">
                      {t.unavailable}
                    </p>
                  ) : (
                    <div className="grid gap-3">
                      {recent.map((work) => renderWork(work, true))}
                      {completed.ownerReads.some((work) => work.envelope.freshness.state !== 'current') ? (
                        <p className="text-xs text-cafe-muted">{t.partial}</p>
                      ) : recent.length === 0 ? (
                        <p className="text-xs text-cafe-muted">{t.recentEmpty}</p>
                      ) : null}
                    </div>
                  )}
                  <button type="button" className="mt-3 text-xs text-cafe-accent" onClick={() => setScope('completed')}>
                    {t.allCompleted}
                  </button>
                </section>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
