'use client';

import type { CSSProperties } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { ReplyRecallButton } from './ReplyRecallButton';
import { ReplyRecordSummary } from './ReplyRecordSummary';
import { type ReplyActivityEvent, ReplyStatusLine, useReplyElapsed } from './ReplyStatusLine';
import activityStyles from './reply-activity.module.css';
import { replyLayersCopy } from './reply-layers.shell-copy';
import type { ReplyStatus } from './reply-status';
import type { ReplySubexecutionRecord } from './reply-subexecution';
import styles from './subexecution.module.css';
import { subexecutionCopy, subexecutionSummary } from './subexecution.shell-copy';

/**
 * F322 B — §1.16: the last line under a cat's reply, the only line that changes. While the cat works it says what it is doing,
 * when something went wrong it says that, and after a normal finish it is only the record ("N 次工具调用 · 时长 ›") with the
 * trajectory at its end. Observed tool calls step the blue cat; other states keep their dot beside body-colour words.
 */
type DotTone = 'info' | 'warning' | 'critical' | 'neutral' | 'hollow';

const DOT_STYLE: Record<DotTone, CSSProperties> = {
  info: { backgroundColor: 'var(--semantic-info)' },
  warning: { backgroundColor: 'var(--semantic-warning)' },
  critical: { backgroundColor: 'var(--semantic-critical)' },
  neutral: { backgroundColor: 'var(--shell-muted)' },
  hollow: { backgroundColor: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--shell-muted)' },
};

/** Text colour of a status: the body text, or (for a line that must surface) its dot colour pulled toward the ink. */
function textColor(tone: DotTone): string {
  if (tone === 'warning' || tone === 'critical') {
    return `color-mix(in oklch, var(--semantic-${tone}) 55%, var(--shell-ink))`;
  }
  return 'var(--shell-body)';
}

function Separator() {
  return (
    <span
      aria-hidden="true"
      className={`flex-none ${styles.separator}`}
      style={{ color: 'var(--shell-muted)', opacity: 0.6 }}
    >
      ·
    </span>
  );
}

function TrajectoryIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="flex-none"
    >
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
    </svg>
  );
}

export interface ReplyLastLineProps {
  status: ReplyStatus | null;
  toolCount: number;
  processCount?: number;
  errorCount: number;
  durationMs: number | null;
  startedAt?: number;
  activityEvent?: ReplyActivityEvent;
  /** F319: the upstream answered with another model; stays on the line while the record is closed. */
  rerouted: boolean;
  /** There is a record to open (tool calls, thinking, or the model/cost line). */
  hasRecord: boolean;
  open: boolean;
  recordId: string;
  onToggle: () => void;
  /** Present when this reply has a trajectory to open. */
  onOpenTrajectory?: () => void;
  recallCount?: number;
  onOpenRecall?: () => void;
  subexecutions?: ReplySubexecutionRecord;
}

function summaryOf(
  t: ReturnType<typeof useShellCopy<typeof replyLayersCopy.zh>>,
  facts: Pick<ReplyLastLineProps, 'toolCount' | 'processCount' | 'errorCount' | 'durationMs' | 'hasRecord'>,
): string | null {
  const processCount = facts.processCount ?? 0;
  const parts = [
    processCount > 0 ? t.record.process(processCount) : null,
    facts.toolCount > 0 ? t.record.toolCalls(facts.toolCount) : null,
    facts.durationMs !== null ? t.record.duration(facts.durationMs) : null,
    facts.errorCount > 0 ? t.record.errors(facts.errorCount) : null,
  ].filter((part): part is string => part !== null);
  // A record that is only thinking or the model line still needs a handle: it is the activity record.
  return parts.length > 0 ? parts.join(' · ') : facts.hasRecord ? t.record.title : null;
}

function ReroutePart({ leading, label }: { leading: boolean; label: string }) {
  return (
    <>
      {leading ? <Separator /> : null}
      <span
        data-testid="reply-reroute"
        data-tone="warning"
        className="inline-flex flex-none items-center gap-1.5"
        style={{ color: textColor('warning') }}
      >
        <span aria-hidden="true" className="inline-block h-2 w-2 flex-none rounded-full" style={DOT_STYLE.warning} />
        {label}
      </span>
    </>
  );
}

function TrajectoryButton({
  leading,
  label,
  title,
  onOpen,
}: {
  leading: boolean;
  label: string;
  title: string;
  onOpen: () => void;
}) {
  return (
    <>
      {leading ? <Separator /> : null}
      <button
        type="button"
        data-testid="reply-trajectory"
        title={title}
        aria-label={title}
        onClick={onOpen}
        className="inline-flex flex-none items-center gap-0.5 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
        style={{ color: 'var(--shell-muted)' }}
      >
        <TrajectoryIcon />
        <span className={styles.trajectoryLabel}>{label}</span>
      </button>
    </>
  );
}

function lastLineSummary(
  props: ReplyLastLineProps,
  t: typeof replyLayersCopy.zh,
  childCopy: typeof subexecutionCopy.zh,
) {
  const stillRunning =
    props.status?.kind === 'working' || props.status?.kind === 'quiet' || props.status?.kind === 'unverified';
  const childrenSummary = props.subexecutions?.total ? subexecutionSummary(childCopy, props.subexecutions) : undefined;
  const summary = summaryOf(t, {
    processCount: props.processCount,
    toolCount: props.toolCount,
    errorCount: stillRunning ? 0 : props.errorCount,
    durationMs: stillRunning ? null : props.durationMs,
    hasRecord: props.hasRecord && !childrenSummary,
  });
  const recordSummary = summary || childrenSummary;
  const activity = Boolean(props.status || props.rerouted || props.recallCount);
  return { childrenSummary, summary, recordSummary, activity };
}

function lastLineLayoutClass(working: boolean, hasChildren: boolean): string {
  return [
    hasChildren ? styles.lastLineChildren : '',
    working ? styles.lastLineWorking : '',
    working && !hasChildren ? activityStyles.ordinaryWorking : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function ReplyLastLine(props: ReplyLastLineProps) {
  const {
    status,
    rerouted,
    hasRecord,
    open,
    recordId,
    onToggle,
    onOpenTrajectory,
    recallCount = 0,
    onOpenRecall,
  } = props;
  const t = useShellCopy(replyLayersCopy);

  const elapsedMs = useReplyElapsed(status?.kind === 'working' || status?.kind === 'quiet', props.startedAt);
  const childCopy = useShellCopy(subexecutionCopy);
  const { childrenSummary, summary, recordSummary, activity } = lastLineSummary(props, t, childCopy);
  if (!activity && !recordSummary && !onOpenTrajectory) return null;

  return (
    <div
      data-testid="reply-last-line"
      className={`${lastLineLayoutClass(status?.kind === 'working', Boolean(childrenSummary))} flex h-[22px] min-w-0 items-center gap-1.5 whitespace-nowrap text-xs`}
      style={{ color: 'var(--shell-muted)' }}
    >
      {status ? <ReplyStatusLine status={status} event={props.activityEvent} /> : null}
      {elapsedMs !== null ? (
        <>
          <Separator />
          <span className={activityStyles.duration}>
            <span data-testid="reply-working-duration" className={activityStyles.durationFull}>
              {t.record.runningDuration(elapsedMs)}
            </span>
            <span data-testid="reply-working-clock" className={activityStyles.durationCompact}>
              {Math.floor(elapsedMs / 60_000)}:{String(Math.floor(elapsedMs / 1000) % 60).padStart(2, '0')}
            </span>
          </span>
        </>
      ) : null}
      {rerouted ? <ReroutePart leading={Boolean(status)} label={t.status.rerouted} /> : null}
      {recallCount > 0 && onOpenRecall ? (
        <ReplyRecallButton
          leading={Boolean(status || rerouted)}
          label={t.record.recall(recallCount)}
          onOpen={onOpenRecall}
        />
      ) : null}
      {recordSummary ? (
        <ReplyRecordSummary
          leading={activity}
          summary={summary ?? ''}
          childrenSummary={childrenSummary}
          subexecutions={props.subexecutions}
          hasRecord={hasRecord}
          open={open}
          recordId={recordId}
          toggleLabel={t.record.toggle(open)}
          onToggle={onToggle}
        />
      ) : null}
      {onOpenTrajectory ? (
        <TrajectoryButton
          leading={Boolean(activity || recordSummary)}
          label={t.record.trajectory}
          title={t.record.openTrajectory}
          onOpen={onOpenTrajectory}
        />
      ) : null}
    </div>
  );
}
