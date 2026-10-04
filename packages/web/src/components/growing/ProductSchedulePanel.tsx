'use client';

import type { ArtifactReviewView, EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEntrustedWorkProjection } from '@/hooks/useEntrustedWorkProjection';
import { ScheduleWorkCard } from './ScheduleWorkCard';
import { WorkCalendarView } from './WorkCalendarView';
import { calendarDateKey, workCalendarDates, workDates } from './work-calendar';
import styles from './work-schedule.module.css';

export type PreparedArtifactCoordinate = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;
export function scheduleItemRef(work: EntrustedWorkOwnerReadV1): string {
  // This is a Workspace return coordinate, not a new Task identity.
  return `${work.envelope.subjectRef}|${work.envelope.revision}${work.completion ? '|completed' : ''}`;
}
const STATE_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 } as const;
const primaryTime = (work: EntrustedWorkOwnerReadV1) => Math.min(...workDates(work).map((time) => time.value));
type WorkFilter = 'all' | 'doing' | 'blocked' | 'untimed';

function matchesWorkView(
  work: EntrustedWorkOwnerReadV1,
  filter: WorkFilter,
  selectedDay: string | null,
  selectedItemRef?: string | null,
): boolean {
  if (scheduleItemRef(work) === selectedItemRef) return true;
  const dates = workDates(work);
  const matchesFilter =
    filter === 'all' || (filter === 'untimed' ? dates.length === 0 : work.brief.current.state === filter);
  return (
    matchesFilter &&
    (!selectedDay ||
      (!work.completion && dates.length === 0) ||
      workCalendarDates(work).some((time) => calendarDateKey(time.value) === selectedDay))
  );
}

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
  const [scope, setScope] = useState<'active' | 'completed'>(() =>
    selectedItemRef?.endsWith('|completed') ? 'completed' : 'active',
  );
  const projection = useEntrustedWorkProjection(scope === 'completed' ? 'completed' : 'schedule');
  const selectedRef = useRef<HTMLElement | null>(null);
  const [month, setMonth] = useState(() => now());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkFilter>('all');
  const currentTime = now();
  const works = useMemo(
    () =>
      projection.ownerReads
        .filter((work) => work.envelope.freshness.state === 'current')
        .sort(
          (a, b) =>
            STATE_ORDER[a.brief.current.state] - STATE_ORDER[b.brief.current.state] ||
            (a.completion && b.completion
              ? (b.completion.recordedAt ?? 0) - (a.completion.recordedAt ?? 0)
              : primaryTime(a) - primaryTime(b)),
        ),
    [projection.ownerReads],
  );
  const visible = works.filter((work) => matchesWorkView(work, filter, selectedDay, selectedItemRef));
  const counts = {
    all: works.length,
    doing: works.filter((work) => work.brief.current.state === 'doing').length,
    blocked: works.filter((work) => work.brief.current.state === 'blocked').length,
    untimed: works.filter((work) => workDates(work).length === 0).length,
  };
  const overdue = works.filter(
    (work) =>
      !work.completion && workDates(work).some((time) => time.role === 'business_deadline' && time.value < currentTime),
  ).length;
  useEffect(() => {
    if (selectedItemRef?.endsWith('|completed')) setScope('completed');
    if (selectedItemRef) selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedItemRef]);

  return (
    <section
      className={`${styles.panel} min-w-0 overflow-x-hidden p-4 sm:p-5`}
      data-testid="product-schedule-panel"
      aria-label="Schedule"
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-micro font-bold uppercase tracking-[0.18em] text-cafe-accent">Schedule</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-cafe-black">工作日历</h2>
        </div>
        <button
          type="button"
          onClick={projection.refetch}
          className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface"
        >
          刷新
        </button>
      </header>
      <fieldset className="mb-4 flex gap-4 border-b border-cafe-subtle text-sm" aria-label="工作范围">
        {(['active', 'completed'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={scope === value}
            className={
              scope === value
                ? 'border-b-2 border-cafe-accent pb-2 font-semibold text-cafe-accent'
                : 'pb-2 text-cafe-muted'
            }
            onClick={() => {
              setScope(value);
              setFilter('all');
              setSelectedDay(null);
            }}
          >
            {value === 'active' ? '当前工作' : '已完成'}
          </button>
        ))}
      </fieldset>
      {projection.loading ? <p className="py-6 text-sm text-cafe-muted">正在读取工作与安排…</p> : null}
      {projection.error ? (
        <div className="rounded-xl border border-semantic-critical bg-semantic-critical-surface p-4 text-sm text-cafe-secondary">
          暂时无法读取工作与安排，请重试刷新。
        </div>
      ) : null}
      {!projection.loading && !projection.error ? (
        <>
          {scope === 'active' ? (
            <fieldset className="mb-4 flex flex-wrap gap-1.5" aria-label="筛选工作">
              {(
                [
                  ['all', '全部'],
                  ['doing', '进行中'],
                  ['blocked', '已阻塞'],
                  ['untimed', '未排期'],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={
                    'rounded-full px-3 py-1.5 text-xs font-medium ' +
                    (filter === key
                      ? 'bg-cafe-black text-cafe-white'
                      : 'bg-cafe-surface text-cafe-secondary hover:text-cafe-accent')
                  }
                >
                  {label} <span className="ml-1 opacity-65">{counts[key]}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          <div className={styles.layout}>
            <WorkCalendarView
              works={works}
              month={month}
              today={currentTime}
              selectedDay={selectedDay}
              onMonth={setMonth}
              onDay={setSelectedDay}
              overdue={overdue}
            />
            <div className={styles.worklist}>
              <div className="mb-3 flex items-center justify-between gap-2 text-xs">
                <h3 className="font-semibold text-cafe-secondary">
                  {selectedDay ? `${selectedDay} 的安排` : scope === 'completed' ? '已完成的工作' : '正在做的事'}{' '}
                  <span className="font-normal text-cafe-muted">· {visible.length}</span>
                </h3>
                {selectedDay ? (
                  <button type="button" className="text-cafe-accent" onClick={() => setSelectedDay(null)}>
                    查看全部工作
                  </button>
                ) : null}
              </div>
              {scope === 'active' && selectedDay && counts.untimed > 0 ? (
                <p className="mb-3 text-xs text-cafe-muted">未排期工作仍保留在下方</p>
              ) : null}
              <div className="grid min-w-0 gap-3">
                {visible.map((work) => {
                  const itemRef = scheduleItemRef(work);
                  return (
                    <ScheduleWorkCard
                      key={work.envelope.subjectRef}
                      ownerRead={work}
                      currentTime={currentTime}
                      itemRef={itemRef}
                      selected={selectedItemRef === itemRef}
                      dateSelected={
                        selectedDay !== null &&
                        workCalendarDates(work).some((time) => calendarDateKey(time.value) === selectedDay)
                      }
                      selectedRef={selectedItemRef === itemRef ? selectedRef : undefined}
                      artifactsLoading={artifactsLoading}
                      onOpenArtifact={onOpenArtifact}
                      onOpenReview={onOpenReview}
                    />
                  );
                })}
                {visible.length === 0 ? (
                  <EmptySchedule hasWork={works.length > 0} completed={scope === 'completed'} />
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function EmptySchedule({ hasWork, completed }: { hasWork: boolean; completed: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-cafe-subtle p-6 text-center">
      <p className="text-sm font-medium text-cafe-black">
        {hasWork ? '这里暂时没有工作' : completed ? '还没有已完成的工作' : '还没有接下的工作'}
      </p>
      <p className="mt-2 text-xs text-cafe-muted">
        {hasWork
          ? '换个日期或筛选，查看其他安排。'
          : completed
            ? '工作完成后，可以在这里回看交付记录。'
            : '在原对话把事情交给猫，接下后会出现在这里。'}
      </p>
    </div>
  );
}
