'use client';

import { useId } from 'react';
import { AppTooltip } from '../AppTooltip';
import { useMeasuredOverflow } from '../content-overflow/useMeasuredOverflow';
import { useShellCopy } from '../shell/shell-copy';
import type { ReplySubexecutionRecord } from './reply-subexecution';
import styles from './subexecution.module.css';
import { subexecutionCopy } from './subexecution.shell-copy';

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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
      style={{ transform: open ? 'rotate(90deg)' : undefined }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export interface RecordSummaryProps {
  leading: boolean;
  summary: string;
  hasRecord: boolean;
  open: boolean;
  recordId: string;
  toggleLabel: string;
  onToggle: () => void;
  childrenSummary?: string;
  subexecutions?: ReplySubexecutionRecord;
}

function ChildSummary({ record, full }: { record: ReplySubexecutionRecord; full: string }) {
  const t = useShellCopy(subexecutionCopy);
  const counts = [
    { kind: 'running', count: record.running, label: t.runningCount(record.running), tone: 'info' },
    { kind: 'failed', count: record.failed, label: t.failedCount(record.failed), tone: 'critical' },
    { kind: 'interrupted', count: record.interrupted, label: t.interruptedCount(record.interrupted), tone: 'muted' },
  ].filter((part) => part.count > 0);
  return (
    <span data-testid="reply-subexecution-summary" data-full-summary={full}>
      <span className={styles.summaryFull} aria-hidden="true">
        {full}
      </span>
      <span className={styles.summaryCompact} aria-hidden="true">
        <span title={t.total(record.total)}>
          <span className={styles.totalLabel}>{t.title} </span>
          {record.total}
        </span>
        {counts.map((part) => (
          <span
            key={part.kind}
            data-subexecution-count={part.kind}
            className="inline-flex items-center gap-0.5"
            title={part.label}
          >
            <svg
              aria-hidden="true"
              width="8"
              height="8"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ color: part.tone === 'muted' ? 'var(--shell-muted)' : `var(--semantic-${part.tone})` }}
            >
              {part.kind === 'running' ? (
                <circle cx="8" cy="8" r="5" fill="currentColor" />
              ) : part.kind === 'failed' ? (
                <path d="M3 3l10 10M13 3L3 13" />
              ) : (
                <rect x="3" y="3" width="10" height="10" />
              )}
            </svg>
            <span>{part.count}</span>
          </span>
        ))}
        {record.completed === record.total ? <span title={t.allFinished}>✓</span> : null}
      </span>
    </span>
  );
}

export function ReplyRecordSummary(props: RecordSummaryProps) {
  const { leading, summary, hasRecord, open, recordId, toggleLabel, onToggle, childrenSummary, subexecutions } = props;
  const summaryId = useId();
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: 'inline', active: hasRecord });
  return (
    <>
      {leading ? <Separator /> : null}
      {hasRecord ? (
        <AppTooltip
          label={[childrenSummary, summary].filter(Boolean).join(' · ')}
          disabled={!overflowing}
          multiline
          side="bottom"
        >
          <button
            type="button"
            data-testid="reply-record-toggle"
            aria-expanded={open}
            aria-controls={recordId}
            aria-label={toggleLabel}
            aria-describedby={childrenSummary ? summaryId : undefined}
            onClick={onToggle}
            className={`${styles.recordToggle} inline-flex min-w-0 items-center gap-0.5 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent`}
            style={{ color: 'var(--shell-muted)' }}
          >
            <span ref={ref} className="truncate" aria-hidden={childrenSummary ? true : undefined}>
              {childrenSummary && subexecutions ? (
                <>
                  <ChildSummary record={subexecutions} full={childrenSummary} />
                  <span className={styles.recordExtras}>
                    {summary ? ' · ' : null}
                    {summary}
                  </span>
                </>
              ) : (
                summary
              )}
            </span>
            <Chevron open={open} />
            {childrenSummary ? (
              <span id={summaryId} className="sr-only">
                {[childrenSummary, summary].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </button>
        </AppTooltip>
      ) : (
        <span data-testid="reply-record-summary" className="flex-none">
          {summary}
        </span>
      )}
    </>
  );
}
