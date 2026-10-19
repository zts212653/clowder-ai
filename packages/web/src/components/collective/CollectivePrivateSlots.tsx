'use client';

import type { ActiveExecutionProjection, CollectiveClientContext, CollectiveUiPlacement } from '@cat-cafe/shared';
import { type CSSProperties, useState } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { ExecutionCancelButton } from '@/components/ExecutionCancelButton';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { CollectiveParticipationRoster } from './CollectiveParticipationRoster';
import { requestStatus } from './CollectiveWorkRequests';
import type { ParticipationView, useCollectiveParticipation } from './use-collective-participation';
import { useCollectiveText } from './use-collective-text';

export function privateChannelRequests(
  view: ParticipationView | undefined,
  context: CollectiveClientContext,
  connectionId: string,
) {
  return (
    view?.requests.filter(
      ({ event }) =>
        event.serviceInstanceId === context.serviceInstanceId &&
        event.collectiveId === context.collectiveId &&
        event.location?.channelId === context.channelId &&
        event.actor.kind === 'human' &&
        event.actor.humanId === context.humanId &&
        event.recipient?.kind === 'agent' &&
        event.recipient.connectionId === connectionId &&
        event.recipient.humanId === context.humanId,
    ) ?? []
  );
}

/** Reads the canonical cancel projection; it never manufactures a target. */
export function executionForPrivateRequest(
  request: ParticipationView['requests'][number],
  executions: readonly ActiveExecutionProjection[],
) {
  const recipient = request.event.recipient;
  if (
    recipient?.kind !== 'agent' ||
    request.execution?.stage !== 'started' ||
    !request.privateThread ||
    !request.execution.invocationId
  )
    return;
  return executions.find(
    (e) =>
      e.threadId === request.privateThread?.id &&
      e.catId === recipient.agentId &&
      e.kind === 'live_invocation' &&
      (e.turnInvocationId ?? e.executionId) === request.execution?.invocationId,
  );
}

/** Private data remains in this Host component. The Service frame supplies only public slot coordinates. */
export function CollectivePrivateSlots({
  slots,
  state,
  context,
  connectionId,
  enabled,
  onPermissions,
}: {
  readonly slots: CollectiveUiPlacement['slots'];
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly context: CollectiveClientContext;
  readonly connectionId: string;
  readonly enabled: boolean;
  readonly onPermissions: () => void;
}) {
  const t = useCollectiveText();
  const [expanded, setExpanded] = useState(false);
  const executions = useActiveExecutionStore((s) => s.executionsByKey);
  const executionReady = useActiveExecutionStore((s) => s.hydration === 'ready');
  const requests = privateChannelRequests(state.view, context, connectionId);
  const active = requests.filter(
    (r) =>
      !r.response &&
      !r.failure &&
      (r.execution?.stage === 'started' || r.execution?.stage === 'queued' || r.attention?.state === 'wake_queued'),
  );
  const renderRequest = (request: ParticipationView['requests'][number], activity = false) => {
    const recipient = request.event.recipient;
    if (recipient?.kind !== 'agent') return null;
    const cat = state.view?.cats.find((c) => c.id === recipient.agentId);
    const execution = executionReady ? executionForPrivateRequest(request, Object.values(executions)) : undefined;
    return (
      <div
        key={request.event.eventId}
        className="flex min-h-7 items-center gap-2 text-xs text-cafe-secondary"
        data-testid="collective-private-receipt"
      >
        {activity && <CatAvatar catId={recipient.agentId} size={20} ring="none" />}
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: request.response
              ? 'var(--semantic-success)'
              : request.failure
                ? 'var(--semantic-critical)'
                : request.execution?.stage === 'started'
                  ? 'var(--semantic-info)'
                  : 'var(--cafe-text-muted)',
          }}
        />
        <span className="min-w-0 flex-1 truncate">
          {cat?.nickname || cat?.displayName || recipient.agentId} · {t(requestStatus(request))}
        </span>
        {activity && execution && <ElapsedTime startedAt={execution.startedAt} />}
        {activity && enabled && execution && <ExecutionCancelButton execution={execution} label={`■ ${t('停止')}`} />}
        {request.privateThread && (
          <a className="shrink-0 underline" href={`/thread/${encodeURIComponent(request.privateThread.id)}`}>
            {t('在家里查看')}
          </a>
        )}
      </div>
    );
  };
  const channelThread = state.view?.channelRoutes[context.channelId]?.threadId;
  return (
    <>
      {active.length > 0 && channelThread && <ActivityHydration threadId={channelThread} />}
      {slots.map((slot) => {
        const style: CSSProperties = {
          position: 'absolute',
          left: slot.x,
          top: slot.y,
          width: slot.width,
          height: slot.height,
          zIndex: 12,
        };
        if (slot.kind === 'roster')
          return (
            <section
              key="roster"
              style={{ ...style, height: 'auto', maxHeight: slot.height }}
              className="overflow-y-auto rounded-xl bg-[var(--shell-frame)] p-4 text-cafe-primary"
              aria-label={t('我的猫 · 仅自己可见')}
            >
              <div className="mb-3 flex items-center justify-between text-xs text-cafe-muted">
                <span>{t('我的 Café · 仅自己可见')}</span>
                <button type="button" onClick={onPermissions} className="underline">
                  {t('已允许的工作…')}
                </button>
              </div>
              {!state.view ? (
                <p>
                  {state.error ?? t('正在读取我的猫…')}{' '}
                  <button type="button" onClick={() => void state.reload()}>
                    {t('重新读取')}
                  </button>
                </p>
              ) : (
                <CollectiveParticipationRoster
                  view={state.view}
                  channelIds={context.channelIds}
                  busy={state.busy}
                  enabled={enabled}
                  mutate={state.mutate}
                />
              )}
              {state.error && (
                <p role="alert" className="mt-2 text-xs">
                  {state.error}
                </p>
              )}
              {state.notice && <output className="block text-xs">{state.notice}</output>}
            </section>
          );
        if (slot.kind === 'receipt') {
          const request = requests.find((r) => r.event.eventId === slot.eventId);
          return request ? (
            <div key={`receipt-${slot.eventId}`} style={style} className="bg-[var(--shell-work)]">
              {renderRequest(request)}
            </div>
          ) : null;
        }
        if (slot.kind !== 'activity' || !active.length) return null;
        return (
          <section
            key="activity"
            style={style}
            className="rounded-lg border border-[color-mix(in_srgb,var(--semantic-info)_25%,transparent)] bg-[var(--info-bg)] px-2"
            aria-label={t('本频道正在为我办事的猫')}
          >
            {active.length === 1 ? (
              renderRequest(active[0], true)
            ) : (
              <>
                <button
                  type="button"
                  className="h-full text-xs"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {active.length} {t('项进行中 · 展开')}
                </button>
                {expanded && (
                  <div className="absolute inset-x-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-lg border border-[var(--shell-hairline)] bg-[var(--shell-paper)] p-3 shadow-lg">
                    {active.map((r) => renderRequest(r, true))}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}

function ActivityHydration({ threadId }: { readonly threadId: string }) {
  useActiveExecutionProjection(threadId, null);
  return null;
}

function ElapsedTime({ startedAt }: { readonly startedAt: number }) {
  const seconds = Math.max(0, Math.floor(useElapsedTime(startedAt) / 1000));
  return (
    <time className="shrink-0 text-cafe-muted">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </time>
  );
}
