'use client';

import { type RoutingContextReadModelV1, routingSignalClosures } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { memberSignalDeadline, SIGNAL_SOURCE_LABELS } from './member-projection';
import { useMemberClock } from './useMemberClock';
export function MemberRoutingHistory({ cat, model }: { cat: Pick<CatData, 'id'>; model?: RoutingContextReadModelV1 }) {
  return model ? <MemberRoutingRecords cat={cat} data={model} /> : <MemberRoutingHistoryReader cat={cat} />;
}
function MemberRoutingHistoryReader({ cat }: { cat: Pick<CatData, 'id'> }) {
  const read = useRoutingContext();
  return <MemberRoutingRecords cat={cat} {...read} />;
}
function MemberRoutingRecords({
  cat,
  data,
  error,
  loading,
  refresh,
}: {
  cat: Pick<CatData, 'id'>;
  data: RoutingContextReadModelV1 | null;
  error?: string | null;
  loading?: boolean;
  refresh?: () => Promise<boolean>;
}) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const now = useMemberClock(data);
  const bindings =
    data?.resolution.state === 'fresh'
      ? data.resolution.snapshot.candidates.map((c) => c.binding)
      : (data?.resolution.candidateBindings ?? []);
  const binding = bindings.find((c) => c.catId === cat.id);
  const closed = routingSignalClosures(data?.signalEvents ?? []);
  const events =
    data?.signalEvents
      .filter((event) => {
        const s = event.subjectRef;
        return s.type === 'cat'
          ? s.catId === cat.id
          : s.type === 'provider'
            ? s.providerId === binding?.providerId
            : !!binding?.provenQuotaPools.some((pool) => pool.poolId === s.poolId);
      })
      .slice()
      .sort((a, b) => b.observedAt - a.observedAt) ?? [];
  return (
    <section>
      <h3>{t('路由历史')}</h3>
      {loading && !data && <p>{t('正在读取…')}</p>}
      {error && (
        <p role="alert">
          {t('读取失败')}{' '}
          <button type="button" className="member-button" onClick={() => void refresh?.()}>
            {t('重试')}
          </button>
        </p>
      )}
      {data && events.length === 0 && <p>{t('没有这个成员的路由记录')}</p>}
      {events.map((event) => (
        <details key={event.eventId} className="member-history-row">
          <summary>
            {t(
              event.eventType === 'asserted'
                ? event.state === 'scarce'
                  ? '额度紧张'
                  : event.state === 'degraded'
                    ? '不稳定'
                    : '不可用'
                : event.eventType === 'recovered'
                  ? '已恢复'
                  : '已撤回',
            )}
            {' · '}
            {t(SIGNAL_SOURCE_LABELS[event.source])}
            {' · '}
            {new Date(event.observedAt).toLocaleString()}
            {event.eventType === 'asserted' &&
              !closed.has(event.eventId) &&
              (event.validUntil ?? event.resetAt) !== undefined && (
                <span>
                  {memberSignalDeadline(event) <= now
                    ? ` · ${t('已失效')}`
                    : ` · ${copy.until(memberSignalDeadline(event))}`}
                </span>
              )}
            {event.note && <small>{event.note}</small>}
          </summary>
          <p>
            {t('记录标识：')}
            <code>{event.eventId}</code>
          </p>
          <p>
            {t('来源依据：')}
            <code>{event.evidenceRef}</code>
          </p>
        </details>
      ))}
    </section>
  );
}
