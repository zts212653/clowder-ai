'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import styles from './reply-activity.module.css';
import { replyLayersCopy } from './reply-layers.shell-copy';
import type { ReplyStatus } from './reply-status';

export interface ReplyActivityEvent {
  id: string;
  timestamp: number;
}

const PULSE_MS = 600;

/** A single pulse belongs to a fresh tool-use event, not to renders, clock ticks or historical hydration. */
function ActivityCat({ event, newCall }: { event: ReplyActivityEvent | undefined; newCall: boolean }) {
  const [pulse, setPulse] = useState(() =>
    Boolean(event && (newCall || (Date.now() >= event.timestamp && Date.now() - event.timestamp < PULSE_MS))),
  );
  useEffect(() => {
    if (!pulse) return;
    const timer = setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulse]);
  return (
    <span
      aria-hidden="true"
      data-testid="reply-activity-cat"
      data-tone="info"
      data-activity-event={event?.id}
      data-pulse={pulse}
      className={`${styles.cat} animate-cat-bounce`}
    >
      ᓚᘏᗢ
    </span>
  );
}

function workingText(status: Extract<ReplyStatus, { kind: 'working' }>, t: typeof replyLayersCopy.zh): string {
  const action = status.action;
  return !action ? t.status.writing : action.kind === 'other' ? t.status.calling(action.tool) : t.status[action.kind];
}

function statusText(status: ReplyStatus, t: typeof replyLayersCopy.zh): string {
  switch (status.kind) {
    case 'working': {
      const action = status.action;
      const text = workingText(status, t);
      return action?.object ? `${text} ${action.object}` : text;
    }
    case 'quiet':
      return status.quietForMs === null
        ? t.status.quietUnknown
        : t.status.quiet(Math.max(1, Math.floor(status.quietForMs / 60_000)));
    case 'unverified':
      return t.status.unverified;
    case 'failed':
      return status.reason ? t.status.failedBecause(t.failure[status.reason]) : t.status.failed;
    case 'stopped':
      return t.status.stopped;
  }
}

const DOTS: Record<Exclude<ReplyStatus['kind'], 'working'>, CSSProperties> = {
  quiet: { backgroundColor: 'var(--semantic-warning)' },
  failed: { backgroundColor: 'var(--semantic-critical)' },
  stopped: { backgroundColor: 'var(--shell-muted)' },
  unverified: { backgroundColor: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--shell-muted)' },
};
const TONES = { quiet: 'warning', failed: 'critical', stopped: 'neutral', unverified: 'hollow' };

export function ReplyStatusLine({ status, event }: { status: ReplyStatus; event?: ReplyActivityEvent }) {
  const t = useShellCopy(replyLayersCopy);
  const detail = status.kind === 'working' ? status.action?.detail : undefined;
  const text = statusText(status, t);
  const previousEvent = useRef(event?.id);
  const newCall = Boolean(event && previousEvent.current !== event.id);
  useEffect(() => {
    previousEvent.current = event?.id;
  }, [event?.id]);
  return (
    <>
      {status.kind === 'working' ? (
        <ActivityCat key={event?.id ?? 'writing'} event={event} newCall={newCall} />
      ) : (
        <span
          data-testid="reply-status-dot"
          data-tone={TONES[status.kind]}
          aria-hidden="true"
          className="inline-block h-2 w-2 flex-none rounded-full"
          style={DOTS[status.kind]}
        />
      )}
      <AppTooltip
        label={text}
        detail={<code className="whitespace-pre-wrap break-all">{detail}</code>}
        side="top"
        multiline
        disabled={!detail}
      >
        <span
          data-testid="reply-status"
          data-status={status.kind}
          tabIndex={detail ? 0 : undefined}
          className={styles.status}
          title={text}
          style={{ color: 'var(--shell-body)' }}
        >
          {status.kind === 'working' && status.action?.object ? (
            <>
              <span className={styles.verb}>{workingText(status, t)} </span>
              <span
                data-testid="reply-tool-object"
                data-short-verb={t.status.compact[status.action.kind]}
                className={styles.object}
              >
                {status.action.object}
              </span>
            </>
          ) : (
            text
          )}
        </span>
      </AppTooltip>
    </>
  );
}

/** Elapsed since this reply's known publication time. Completion continues to use provider-reported duration. */
export function useReplyElapsed(active: boolean, startedAt: number | undefined): number | null {
  const [, tick] = useState(0);
  const known = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0;
  useEffect(() => {
    if (!active || !known) return;
    const interval = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [active, known]);
  return active && known ? Math.max(0, Date.now() - startedAt) : null;
}
