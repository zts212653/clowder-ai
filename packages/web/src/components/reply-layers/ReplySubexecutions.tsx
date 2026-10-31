'use client';

import type { ProviderSubexecutionSemanticEvent as Event } from '@cat-cafe/shared';
import { useState } from 'react';
import { catColorVar } from '@/lib/cat-slug';
import { usePublishLayoutAfterDisclosure } from '../cli-output/CliOutputBlock';
import { useShellCopy } from '../shell/shell-copy';
import { replyLayersCopy } from './reply-layers.shell-copy';
import type { ReplySubexecution, ReplySubexecutionRecord } from './reply-subexecution';
import styles from './subexecution.module.css';
import { subexecutionCopy, subexecutionSummaryParts } from './subexecution.shell-copy';

function Message({ event, primary = false }: { event: Event; primary?: boolean }) {
  const t = useShellCopy(subexecutionCopy);
  const label =
    event.messagePhase === 'final_answer'
      ? t.final
      : event.messagePhase === 'commentary'
        ? primary
          ? t.latest
          : t.progress
        : t.unknown;
  return (
    <div data-subexecution-message-phase={event.messagePhase ?? 'unknown'} className="space-y-1">
      <div className="text-xs font-medium" style={{ color: 'var(--shell-muted)' }}>
        {label}
      </div>
      <div className="whitespace-pre-wrap break-words text-xs leading-5" style={{ color: 'var(--shell-body)' }}>
        {event.content}
      </div>
    </div>
  );
}

function ChildHeader({
  group,
  catId,
  open,
  toggle,
}: {
  group: ReplySubexecution;
  catId: string;
  open: boolean;
  toggle: () => void;
}) {
  const t = useShellCopy(subexecutionCopy);
  const common = useShellCopy(replyLayersCopy);
  const stage = group.status === 'started' || group.status === 'message' ? 'running' : group.status;
  const tone = { failed: 'critical', running: 'info', completed: 'success', interrupted: 'muted' }[stage];
  const duration =
    group.durationMs === null
      ? '—'
      : group.durationMs === 0
        ? t.zeroDuration
        : common.record.duration(group.durationMs);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className={`${styles.row} min-h-11 w-full min-w-0 items-center gap-x-2 border-b py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent`}
      style={{ borderColor: 'var(--shell-hairline)', color: 'var(--shell-body)' }}
    >
      <span className={`${styles.name} flex min-w-0 items-center`}>
        <span
          data-subexecution-name
          className="inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium"
          style={{ color: catColorVar(catId, 'text'), backgroundColor: catColorVar(catId, 'surface') }}
          title={group.nickname ?? t.title}
        >
          {group.nickname ?? t.title}
        </span>
      </span>
      <code data-subexecution-task className={`${styles.task} min-w-0 truncate text-xs`} title={group.taskId}>
        {group.taskId}
      </code>
      <span
        data-subexecution-state
        className={`${styles.state} inline-flex items-center gap-1 whitespace-nowrap text-xs`}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{ backgroundColor: tone === 'muted' ? 'var(--shell-muted)' : `var(--semantic-${tone})` }}
        />
        {t[stage]}
      </span>
      <span
        data-subexecution-duration
        className={`${styles.duration} whitespace-nowrap text-xs tabular-nums`}
        style={{ color: 'var(--shell-muted)' }}
      >
        {duration}
      </span>
      <svg
        aria-hidden="true"
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={styles.chevron}
        style={{ color: 'var(--shell-muted)', transform: open ? 'rotate(90deg)' : undefined }}
      >
        <path d="M6 3l5 5-5 5" />
      </svg>
    </button>
  );
}

function ChildMessages({ group }: { group: ReplySubexecution }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  usePublishLayoutAfterDisclosure(historyOpen);
  const t = useShellCopy(subexecutionCopy);
  return (
    <div className={`${styles.details} min-w-0`}>
      {group.primary ? (
        <Message event={group.primary} primary />
      ) : (
        <div className="text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.noMessage}
        </div>
      )}
      {group.earlier.length ? (
        <>
          <button
            type="button"
            data-subexecution-history-toggle
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
            className="min-h-6 self-start rounded text-left text-xs leading-5 hover:underline focus-visible:ring-2 focus-visible:ring-cafe-accent"
            style={{ color: 'var(--shell-muted)' }}
          >
            {historyOpen ? '⌄' : '›'} {t.earlier(group.earlier.length)}
          </button>
          {historyOpen ? group.earlier.map((event) => <Message key={event.id} event={event} />) : null}
        </>
      ) : null}
      <div className="break-all text-xs leading-5" style={{ color: 'var(--shell-muted)' }}>
        {t.taskId} <code>{group.taskId}</code>
      </div>
    </div>
  );
}

function ChildRow({ group, catId, level }: { group: ReplySubexecution; catId: string; level: number }) {
  const [open, setOpen] = useState(false);
  usePublishLayoutAfterDisclosure(open);
  const stage = group.status === 'started' || group.status === 'message' ? 'running' : group.status;
  return (
    <div data-subexecution-container={group.id} className="min-w-0">
      <div
        data-subexecution-id={group.id}
        data-subexecution-status={stage}
        className="min-w-0"
        style={{ paddingInlineStart: `min(${level * 12}px, 15%)` }}
      >
        <ChildHeader group={group} catId={catId} open={open} toggle={() => setOpen((value) => !value)} />
        {open ? <ChildMessages group={group} /> : null}
      </div>
      {group.children.map((child) => (
        <ChildRow key={child.key} group={child} catId={catId} level={level + 1} />
      ))}
    </div>
  );
}

export function ReplySubexecutions({ record, catId }: { record: ReplySubexecutionRecord; catId: string }) {
  const t = useShellCopy(subexecutionCopy);
  if (!record.total) return null;
  return (
    <section
      data-testid="reply-subexecutions"
      data-quote-exclude="true"
      aria-label={t.title}
      className={`${styles.group} min-w-0 space-y-1.5`}
    >
      <div
        data-testid="reply-subexecution-group-title"
        className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
        style={{ color: 'var(--shell-muted)' }}
      >
        {subexecutionSummaryParts(t, record).map((part, index) => (
          <span key={part} className="inline-flex items-center gap-1 whitespace-nowrap">
            {index ? <span aria-hidden="true"> · </span> : null}
            <span style={index === 0 ? { color: 'var(--shell-body)' } : undefined}>{part}</span>
          </span>
        ))}
      </div>
      {record.roots.map((group) => (
        <ChildRow key={group.key} group={group} catId={catId} level={0} />
      ))}
    </section>
  );
}
