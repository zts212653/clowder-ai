import { useEffect, useState } from 'react';
import { MemoryEventCorrections } from './MemoryEventCorrections';
import { MemoryForgetControl, MemoryOwnerFeedback, MemoryOwnerSource } from './MemoryOwnerControls';
import { MemoryReadState } from './MemoryReadState';
import type { MemoryEvent } from './owner-memory-read';
import { readEvent } from './read-memory-event';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { formatMemoryDate } from './use-memory-read';

export function MemoryEventDetail({
  entry,
  close,
  reload,
}: {
  entry: MemoryEvent;
  close: () => void;
  reload: () => void;
}) {
  const path = `/api/memory/events/${encodeURIComponent(entry.eventId)}`;
  const [data, setData] = useState<MemoryEvent | null>(null);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState('');
  const [retiring, setRetiring] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed complete read
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setData(null);
    setError(false);
    readEvent(entry.eventId, controller.signal)
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setSummary(value.summary);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [entry.eventId, attempt]);
  const action = useMemoryOwnerAction(`${path}/actions`, entry.eventId, () => {
    close();
    reload();
  });
  return (
    <aside
      aria-label="事件详情"
      className="space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex justify-between gap-3">
        <h2 className="text-base font-medium">事件详情</h2>
        <button type="button" className="text-compact text-cafe-accent underline" onClick={close}>
          返回事件
        </button>
      </div>
      <MemoryReadState
        loading={!data && !error}
        error={error}
        empty={false}
        noun="完整事件"
        retry={() => retry((value) => value + 1)}
      />
      <MemoryOwnerFeedback action={action} reread={reload} />
      {data && (
        <>
          <h3 className="text-display-sm">{data.type}</h3>
          <p className="text-xs text-cafe-muted">
            {formatMemoryDate(data.timestamp)} · {data.status === 'retired' ? '已不再使用' : '当前记录'}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{data.summary}</p>
          <MemoryOwnerSource endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`} />
          {data.correctionProposals && (
            <MemoryEventCorrections proposals={data.correctionProposals} revision={data.revision} reread={reload} />
          )}
          {data.status === 'active' && (
            <>
              <div className="flex gap-3 text-compact text-cafe-accent">
                <button type="button" disabled={action.blocked} onClick={() => setEditing(!editing)}>
                  修改事件
                </button>
                <button type="button" disabled={action.blocked} onClick={() => setRetiring(!retiring)}>
                  不再使用
                </button>
              </div>
              {editing && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (summary.trim())
                      action.submit({
                        action: 'correct',
                        expectedRevision: data.revision,
                        patch: { summary: summary.trim() },
                      });
                  }}
                >
                  <label className="block text-compact">
                    事件内容
                    <textarea
                      aria-label="事件内容"
                      required
                      maxLength={1_000_000}
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      className="mt-1 min-h-32 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                    />
                  </label>
                  <button type="submit" disabled={action.blocked} className="text-compact text-cafe-accent underline">
                    保存事件
                  </button>
                </form>
              )}
              {retiring && (
                <div className="space-y-2 text-compact">
                  <p>停止用于新的召回，保留事件历史。</p>
                  <button
                    type="button"
                    disabled={action.blocked}
                    onClick={() => action.submit({ action: 'retire', expectedRevision: data.revision })}
                    className="text-cafe-accent underline"
                  >
                    确认不再使用
                  </button>
                </div>
              )}
            </>
          )}
          <MemoryForgetControl revision={data.revision} noun="事件" action={action} />
        </>
      )}
    </aside>
  );
}
