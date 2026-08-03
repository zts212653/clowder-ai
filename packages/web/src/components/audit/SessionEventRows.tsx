'use client';

import { CompactLabel, CriticalText } from '../content-overflow';

export interface HandoffSummary {
  invocationId: string;
  eventCount: number;
  toolCalls: string[];
  errors: number;
  durationMs: number;
  keyMessages: string[];
}

export interface RawEvent {
  eventNo: number;
  v: number;
  t: number;
  catId: string;
  event: Record<string, unknown>;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function keyedToolCalls(toolCalls: string[]) {
  const occurrences = new Map<string, number>();
  return toolCalls.map((label) => {
    const occurrence = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, occurrence);
    return { key: `${label}-${occurrence}`, label };
  });
}

function rawEventType(event: Record<string, unknown>): string {
  const type = event.type;
  if (typeof type === 'string' && type.trim()) return type;
  const kind = event.kind;
  if (typeof kind === 'string' && kind.trim()) return kind;
  return 'event';
}

export function HandoffEventRows({ invocations }: { invocations: HandoffSummary[] }) {
  return (
    <div className="space-y-1.5">
      {invocations.map((invocation) => (
        <div
          key={invocation.invocationId}
          className="rounded border border-[var(--console-border-soft)] px-2 py-1.5 text-xs"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <CompactLabel
              label="Invocation ID"
              value={invocation.invocationId}
              className="min-w-0 flex-1 font-mono text-cafe-secondary"
            />
            <span className="shrink-0 text-cafe-muted">{fmtDuration(invocation.durationMs)}</span>
            {invocation.errors > 0 && <span className="shrink-0 text-conn-red-text">{invocation.errors} err</span>}
          </div>
          <div className="flex flex-wrap gap-1 mt-1">
            {keyedToolCalls(invocation.toolCalls ?? []).map((toolCall) => (
              <span
                key={toolCall.key}
                className="bg-cafe-surface-elevated text-cafe-secondary px-1 py-0.5 rounded text-micro"
              >
                {toolCall.label}
              </span>
            ))}
          </div>
          {(invocation.keyMessages ?? []).length > 0 && (
            <div data-testid="handoff-key-message" className="mt-1 min-w-0">
              <CriticalText summary="交接关键消息" details={invocation.keyMessages[0]} tone="warning" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function RawEventRows({ events }: { events: RawEvent[] }) {
  return (
    <div className="space-y-1">
      {events.map((event) => (
        <div key={event.eventNo} className="rounded bg-cafe-surface-elevated px-2 py-1.5">
          <CriticalText
            summary={`#${event.eventNo} · ${rawEventType(event.event)}`}
            details={JSON.stringify(event.event, null, 2)}
            tone="info"
            className="[&>p]:font-mono [&>p]:text-xs [&>p]:text-cafe-secondary"
          />
        </div>
      ))}
    </div>
  );
}
