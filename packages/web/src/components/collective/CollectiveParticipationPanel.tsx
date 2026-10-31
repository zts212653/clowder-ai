'use client';
import { useMemo } from 'react';
import { participationControl } from './CollectiveCatParticipation';
import { CollectiveParticipationRoster } from './CollectiveParticipationRoster';
import { CollectiveWorkPolicySettings } from './CollectiveWorkPolicySettings';
import { CollectiveWorkRequests } from './CollectiveWorkRequests';
import { useCollectiveAutoReconcile, useCollectiveParticipation } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export type { ParticipationView } from './use-collective-participation';

export function CollectiveParticipationPanel({
  connectionId,
  channelId,
  channels,
}: {
  readonly connectionId: string;
  readonly channelId: string;
  readonly channels: readonly string[];
}) {
  const state = useCollectiveParticipation(connectionId);
  const channelIds = useMemo(() => [...new Set([...channels, channelId])], [channelId, channels]);
  useCollectiveAutoReconcile(state, channelIds);
  return <CollectiveParticipationContent state={state} channelId={channelId} channels={channels} />;
}

export function CollectiveParticipationContent({
  state,
  channelId,
  channels,
  canParticipate = true,
  workPolicy,
  surface = 'all',
}: {
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly canParticipate?: boolean;
  readonly workPolicy?: CollectiveWorkPolicyState;
  readonly surface?: 'all' | 'roster' | 'work' | 'policy';
}) {
  const { view, busy, error, notice, mutate, reload } = state;
  const channelIds = useMemo(() => [...new Set([...channels, channelId])].sort(), [channelId, channels]);
  const requests =
    view?.requests.filter(
      (request) =>
        request.event.location?.channelId === channelId ||
        (!request.event.location &&
          request.event.target.kind === 'channel' &&
          request.event.target.channelId === channelId),
    ) ?? [];
  return (
    <div className="space-y-5">
      {(surface === 'all' || surface === 'policy') && view && workPolicy && (
        <CollectiveWorkPolicySettings state={workPolicy} view={view} channelId={channelId} enabled={canParticipate} />
      )}
      {!canParticipate && (
        <p className="text-xs text-cafe-muted">连接已撤销，原有私人工作仍然保留。重新配对后可以再安排参与。</p>
      )}
      {(surface === 'all' || surface === 'roster') && view && (
        <CollectiveParticipationRoster
          view={view}
          channelIds={channelIds}
          busy={busy}
          enabled={canParticipate}
          mutate={mutate}
        />
      )}
      {(surface === 'all' || surface === 'work') && (
        <section className="border-t border-[var(--console-border-soft)] pt-4" aria-label="日程">
          <h3 className="mb-3 text-sm font-semibold">这段讨论带回的请求与工作</h3>
          {!view ? (
            <p className="text-xs leading-5 text-cafe-muted">{error ?? '正在读取这段讨论的工作…'}</p>
          ) : !requests.length ? (
            <p className="text-xs leading-5 text-cafe-muted">本频道还没有带回的工作。</p>
          ) : (
            <CollectiveWorkRequests
              requests={requests}
              tasks={view.tasks}
              busy={busy}
              mutate={async (path, body) => {
                await mutate(path, body);
              }}
              control={participationControl}
            />
          )}
        </section>
      )}
      {error && (
        <div role="alert" className="text-xs text-conn-red-text">
          <p>{error}</p>
          <button type="button" className="mt-2 underline" onClick={() => void reload()}>
            重新读取
          </button>
        </div>
      )}
      {notice && <output className="block text-xs leading-5 text-cafe-secondary">{notice}</output>}
    </div>
  );
}
