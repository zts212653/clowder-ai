import { useEffect, useMemo, useRef } from 'react';
import { Composer, type HumanMention, type MentionSelection } from './Composer.js';
import type { ClientTarget, CollectiveParticipant, DeliveryState } from './client-types.js';
import type { FirstEntryGuide } from './first-entry/use-first-entry-guide.js';

export function ChannelComposer({
  namespace,
  channelId,
  participants,
  humans,
  delivery,
  mention,
  onSend,
  onCafe,
  firstEntry,
}: {
  readonly namespace: string;
  readonly channelId: string;
  readonly participants: readonly CollectiveParticipant[];
  readonly humans: readonly HumanMention[];
  readonly delivery: DeliveryState;
  readonly mention?: MentionSelection;
  readonly onSend: (body: string, destination: ClientTarget) => Promise<void>;
  readonly onCafe?: () => void;
  readonly firstEntry?: FirstEntryGuide;
}) {
  const host = useRef<HTMLDivElement>(null);
  const guidePhase = firstEntry?.phase;
  const guideCat = firstEntry?.narrator;
  const guideConnectionId = guideCat?.connectionId;
  const guideHumanId = guideCat?.humanId;
  const guideCatId = guideCat?.catId;
  const guideRevision = guideCat?.participationRevision;
  const guideName = guideCat?.displayName;
  let hasDraft = false;
  if (guidePhase === 'handoff') {
    try {
      const saved: unknown = JSON.parse(
        window.localStorage.getItem(`collective-draft:${namespace}:${channelId}:channel`) ?? 'null',
      );
      hasDraft = Boolean(
        saved && typeof saved === 'object' && 'body' in saved && typeof saved.body === 'string' && saved.body.trim(),
      );
    } catch {
      // An unavailable or malformed browser draft must not block the first prompt.
    }
  }
  const guideMention = useMemo(
    () =>
      guidePhase === 'handoff' &&
      !hasDraft &&
      guideConnectionId &&
      guideHumanId &&
      guideCatId &&
      guideRevision &&
      guideName
        ? {
            recipient: {
              kind: 'agent' as const,
              connectionId: guideConnectionId,
              humanId: guideHumanId,
              agentId: guideCatId,
              participationRevision: guideRevision,
            },
            label: guideName,
          }
        : undefined,
    [guidePhase, hasDraft, guideConnectionId, guideHumanId, guideCatId, guideRevision, guideName],
  );
  useEffect(() => {
    host.current?.toggleAttribute('inert', firstEntry?.phase === 'playing');
  }, [firstEntry?.phase]);
  return (
    <>
      {firstEntry?.phase === 'handoff' && (
        <p className="first-entry-audience">#general 是公开频道 · 这个 Collective 的成员都看得到</p>
      )}
      {firstEntry?.phase === 'empty' && (
        <output className="first-entry-hint">
          这台 Café 还没有可参与的伙伴。
          {onCafe && (
            <button type="button" onClick={onCafe}>
              去我的 Café 登记
            </button>
          )}
        </output>
      )}
      {firstEntry?.phase === 'loading' && firstEntry.pairStarted && (
        <output className="first-entry-hint">正在带入伙伴…</output>
      )}
      {firstEntry?.hintVisible && (
        <output className="first-entry-hint">
          成员 · 看看谁在这里 / 我的 Café · 随时增减伙伴
          <button type="button" onClick={firstEntry.dismissHint}>
            知道了
          </button>
        </output>
      )}
      <div ref={host} className="first-entry-composer-host">
        <Composer
          key={`${namespace}:${channelId}`}
          namespace={namespace}
          channelId={channelId}
          participants={participants}
          humans={humans}
          placeholder={`在 #${channelId} 里说点什么……`}
          delivery={delivery}
          mention={guideMention ?? mention}
          onSend={async (body, recipient, entrust, responseRequested) => {
            await onSend(body, {
              location: { channelId },
              recipient,
              ...(responseRequested && recipient.kind === 'channel'
                ? { attentionRequest: 'response_requested' as const }
                : {}),
              ...(entrust && recipient.kind === 'agent' ? { workRequest: 'entrust' } : {}),
            });
            if (firstEntry?.phase === 'handoff') firstEntry.markSent();
          }}
        />
      </div>
    </>
  );
}
