'use client';

import type { RoutingPreferenceRevisionV1, RoutingSignalEventV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';
import { useRoutingContext } from './useRoutingContext';

function subjectLabel(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return subject.catId;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `pool:${subject.poolId}`;
}

function eventBoundary(event: RoutingSignalEventV1): string {
  if (event.eventType === 'asserted') {
    const boundary = event.validUntil ?? event.resetAt;
    return boundary ? `至 ${new Date(boundary).toLocaleString()}` : '无有效边界';
  }
  return `关闭 ${event.closesSignalIds.join(', ')}`;
}

function preferenceRule(revision: RoutingPreferenceRevisionV1): string {
  return `${revision.prefer.map(subjectLabel).join(', ')} 优先于 ${revision.over.map(subjectLabel).join(', ')}`;
}

export function RoutingContextLedger() {
  const { data, loading, error, refresh } = useRoutingContext();

  return (
    <section className="space-y-4" data-testid="routing-context-ledger" data-ledger-mode="read-only">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-cafe-black">路由账本</h2>
          <p className="mt-1 text-xs leading-5 text-cafe-muted">
            完整历史来自猫猫团队使用的同一 read model；这里仅供追溯，写动作只在 Workspace「猫猫团队」。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="h-8 rounded-lg border border-cafe-subtle px-3 text-micro font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
        >
          刷新账本
        </button>
      </div>

      {loading && !data ? <p className="text-xs text-cafe-muted">正在读取路由账本…</p> : null}
      {error && !data ? <p className="text-xs text-conn-red-text">{error}</p> : null}
      {data ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
            <h3 className="text-xs font-semibold text-cafe-black">信号事件 · {data.signalEvents.length}</h3>
            <div className="mt-3 space-y-2">
              {data.signalEvents.length === 0 ? (
                <p className="text-xs text-cafe-muted">暂无信号事件</p>
              ) : (
                data.signalEvents.map((event) => (
                  <article key={event.eventId} className="rounded-lg border border-cafe-subtle bg-cafe-surface/60 p-3">
                    <p className="text-xs font-semibold text-cafe-black">
                      {subjectLabel(event.subjectRef)} · {event.eventType}
                    </p>
                    <p className="mt-1 text-micro text-cafe-secondary">
                      {event.reasonCode} · {event.source} · {eventBoundary(event)}
                    </p>
                    <p className="mt-1 break-all text-micro text-cafe-muted">
                      {event.eventId} · {event.evidenceRef}
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
            <h3 className="text-xs font-semibold text-cafe-black">偏好版本 · {data.preferenceRevisions.length}</h3>
            <div className="mt-3 space-y-2">
              {data.preferenceRevisions.length === 0 ? (
                <p className="text-xs text-cafe-muted">暂无偏好版本</p>
              ) : (
                data.preferenceRevisions.map((revision) => (
                  <article
                    key={revision.revisionId}
                    className="rounded-lg border border-cafe-subtle bg-cafe-surface/60 p-3"
                  >
                    <p className="text-xs font-semibold text-cafe-black">
                      {revision.lifecycle} · v{revision.version} · {preferenceRule(revision)}
                    </p>
                    <p className="mt-1 text-micro text-cafe-secondary">{revision.rationale}</p>
                    <p className="mt-1 break-all text-micro text-cafe-muted">
                      {revision.revisionId} · {revision.evidenceRefs.join(' · ')}
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
