'use client';

import type { CatInvocationInfo, ContextHealthData } from '@/stores/chat-types';
import { BindSessionInput, SessionIdTag } from '../SessionChainInputs';
import {
  runtimeLifecycleLabel,
  type SessionChainProjection,
  type SessionSummary,
  sealReasonLabel,
} from '../SessionChainPanel';
import { sessionChainCopy } from '../session-chain.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { formatTokenCount } from '../status-helpers';
import { SessionContextV2 } from './SessionContextV2';
import { sessionRowCopy } from './session-row.shell-copy';

function age(timestamp: number, t: typeof sessionRowCopy.zh.ago): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return t.seconds(seconds);
  if (seconds < 3600) return t.minutes(Math.floor(seconds / 60));
  if (seconds < 86400) return t.hours(Math.floor(seconds / 3600));
  return t.days(Math.floor(seconds / 86400));
}

export function SessionRowV2({
  session,
  owner,
  invocation,
  threadId,
  onView,
}: {
  session: SessionSummary;
  owner: SessionChainProjection;
  invocation?: CatInvocationInfo;
  threadId: string;
  onView: (session: SessionSummary) => void;
}) {
  const t = useShellCopy(sessionRowCopy);
  const chain = useShellCopy(sessionChainCopy);
  const unsealed = session.status === 'active';
  const running = owner.runningCatIds.has(session.catId);
  const count = owner.unsealedCountByCat.get(session.catId) ?? 0;
  const ambiguous = count > 1;
  const firstUnsealed = owner.sessions.find((record) => record.catId === session.catId && record.status === 'active');
  // Same attribution as the existing owner: live telemetry only belongs to the one unsealed running record.
  const live = unsealed && running && count === 1;
  const health: ContextHealthData | undefined =
    (live ? invocation?.contextHealth : undefined) ??
    (session.contextHealth ? { ...session.contextHealth, measuredAt: session.createdAt } : undefined);
  const usage = (live ? invocation?.usage : undefined) ?? session.lastUsage;
  const cache =
    usage?.cacheReadTokens && usage.inputTokens ? Math.round((usage.cacheReadTokens / usage.inputTokens) * 100) : null;
  const cannotTarget = owner.isStale || running || ambiguous;
  const switchWarning = session.runtimeSession?.unexpectedRuntimeSessionSwitch;
  return (
    <article className="status-v2-session" data-session-id={session.id} data-session-lifecycle={session.status}>
      <div className="status-v2-session-title">
        <strong>{t.session(session.seq + 1)}</strong>
        <SessionIdTag id={session.cliSessionId ?? session.id} />
      </div>
      <p className="status-v2-muted">
        {t.started(age(session.createdAt, t.ago))} · {chain.messages(session.messageCount)} ·{' '}
        {session.compressionCount == null
          ? t.compressionUnknown
          : session.compressionCount === 0
            ? t.noCompression
            : t.compressed(session.compressionCount)}
      </p>
      {!unsealed && (
        <p className="status-v2-muted">
          {session.status === 'sealed' ? chain.sealed : chain.sealing}
          {session.sealedAt ? ` · ${t.archivedAt(age(session.sealedAt, t.ago))}` : ''}
          {session.sealReason ? ` · ${sealReasonLabel(session.sealReason, chain)}` : ''}
        </p>
      )}
      {session.runtimeSession && (
        <div className="status-v2-runtime status-v2-muted">
          <span>{chain.runtime}</span>
          <SessionIdTag id={session.runtimeSession.runtimeSessionId} />
          <span>{session.runtimeSession.runtime}</span>
          <span>{runtimeLifecycleLabel(session.runtimeSession.lifecycleState, chain)}</span>
          {session.runtimeSession.runtimeConversationId && (
            <SessionIdTag id={session.runtimeSession.runtimeConversationId} label={chain.runtimeConversationId} />
          )}
        </div>
      )}
      {switchWarning && (
        <div className="status-v2-notice">
          <span>{chain.unexpectedSwitch}</span>
          <SessionIdTag id={switchWarning.previousRuntimeSessionId} />
          <span>→</span>
          <SessionIdTag id={switchWarning.currentRuntimeSessionId} />
        </div>
      )}
      {usage && (
        <p className="status-v2-tokens">
          {usage.inputTokens != null && <span title={t.inputHint}>{t.input(formatTokenCount(usage.inputTokens))}</span>}
          {usage.outputTokens != null && <span>{t.output(formatTokenCount(usage.outputTokens))}</span>}
          {cache != null && <span>{t.cache(cache)}</span>}
          {usage.costUsd != null && <span>${usage.costUsd.toFixed(4)}</span>}
        </p>
      )}
      <SessionContextV2 catId={session.catId} health={health} />
      {ambiguous && unsealed && firstUnsealed?.id === session.id && (
        <p className="status-v2-session-warning">
          <span className="status-v2-dot" style={{ background: 'var(--semantic-warning)' }} />
          <span>{t.ambiguity(count)}</span>
        </p>
      )}
      {ambiguous && session.status === 'sealed' && <p className="status-v2-muted">{t.restoreAmbiguity}</p>}
      <div className="status-v2-actions">
        {unsealed && session.cliSessionId && (
          <button
            type="button"
            data-testid={`compact-native-session-${session.id}`}
            disabled={cannotTarget || owner.compactingSessionId !== null}
            onClick={() => void owner.onCompact(session)}
          >
            {owner.compactingSessionId === session.id ? chain.compacting : t.compact}
          </button>
        )}
        {unsealed && (
          <button
            type="button"
            data-testid={`seal-session-${session.id}`}
            disabled={owner.isStale || running || owner.sealingSessionId !== null}
            onClick={() => void owner.onSeal(session.id)}
          >
            {owner.sealingSessionId === session.id ? chain.sealingEllipsis : t.archive}
          </button>
        )}
        {!unsealed && (
          <button type="button" data-testid={`view-session-${session.id}`} onClick={() => onView(session)}>
            {t.history}
          </button>
        )}
        {session.status === 'sealed' && (
          <button
            type="button"
            data-testid={`restore-session-${session.id}`}
            disabled={cannotTarget || owner.restoringSessionId !== null}
            onClick={() => void owner.onRestore(session)}
          >
            {owner.restoringSessionId === session.id ? chain.restoring : chain.restoreCurrent}
          </button>
        )}
        {unsealed && threadId !== 'default' && (
          <BindSessionInput
            threadId={threadId}
            catId={session.catId}
            disabled={cannotTarget}
            onBound={owner.onRefresh}
          />
        )}
        {running && <span className="status-v2-muted">{unsealed ? t.stopBeforeActions : t.stopBeforeRestore}</span>}
      </div>
    </article>
  );
}
