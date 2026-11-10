import type { MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { MemoryDeliveryUsage } from './MemoryDeliveryUsage';
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
  deliveryRevision,
  onApplied,
  onDecisionApplied,
}: {
  entry: MemoryEvent;
  close: () => void;
  reload: () => void;
  deliveryRevision?: string;
  onApplied?: (receipt: MemoryOwnerActionReceipt) => void;
  onDecisionApplied?: () => void;
}) {
  const { getCatById } = useCatData();
  const cat = getCatById(entry.cat);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
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
    readEvent(entry.eventId, controller.signal, attempt > 0, deliveryRevision)
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
  }, [entry.eventId, attempt, deliveryRevision]);
  const action = useMemoryOwnerAction(
    `${path}/actions`,
    entry.eventId,
    onApplied ??
      (() => {
        close();
        reload();
      }),
  );
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
          <h3 className="whitespace-pre-wrap break-words font-serif text-display-sm">{data.summary}</h3>
          <p className="text-xs text-cafe-muted">
            {cat?.nickname || cat?.displayName || '猫名没有记录下来'} · {formatMemoryDate(data.timestamp)} ·{' '}
            {
              {
                human_brake: '你拉闸',
                cat_brake: '猫主动刹车',
                cat_shout: '猫互相提醒',
                flywheel_selffix: '自我修复',
                lesson_settle: '教训沉淀',
              }[data.trigger]
            }{' '}
            · {data.type}
          </p>
          <p className="text-compact text-cafe-muted">● {data.status === 'retired' ? '已不再使用' : '生效中'}</p>
          <MemoryOwnerSource
            endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`}
            onReadState={setSourceState}
          />
          {data.correctionProposals && (
            <MemoryEventCorrections
              proposals={data.correctionProposals}
              revision={data.revision}
              reread={reload}
              onDecided={onDecisionApplied}
            />
          )}
          {data.status === 'active' && (
            <>
              <div className="flex gap-3 text-compact text-cafe-accent">
                <button
                  type="button"
                  disabled={action.blocked || sourceState !== 'ready'}
                  className="console-button-secondary disabled:opacity-50"
                  onClick={() => setEditing(!editing)}
                >
                  编辑
                </button>
                <button type="button" disabled={action.blocked} onClick={() => setRetiring(!retiring)}>
                  不再使用
                </button>
              </div>
              {sourceState === 'unavailable' && (
                <p className="text-xs text-cafe-muted">
                  来源读不到，暂时不能编辑。可以重读来源，或者不再使用、忘掉这条。
                </p>
              )}
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
                  <p className="text-xs text-cafe-muted">改的是这条记忆，原对话里的消息不会改。</p>
                  <button
                    type="submit"
                    disabled={action.blocked || sourceState !== 'ready'}
                    className="text-compact text-cafe-accent underline"
                  >
                    保存
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
          <MemoryForgetControl revision={data.revision} noun="事件" action={action} quiet />
          <section className="space-y-2 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">什么时候会想起</h4>
            <p className="text-sm">同一条对话里最近 15 分钟内、把握高的事件，可能递送。</p>
          </section>
          <MemoryDeliveryUsage family="event" anchor={`event-memory:${data.eventId}`} />
        </>
      )}
    </aside>
  );
}
