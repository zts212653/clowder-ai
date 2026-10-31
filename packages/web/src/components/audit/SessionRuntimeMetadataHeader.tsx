'use client';

import { sessionChainCopy } from '@/components/session-chain.shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useTrajectoryCopy } from '@/components/workspace/trajectory/use-trajectory-copy';

import { useCatTechnicalLabelResolver } from '@/hooks/useCatNameResolver';
import { CompactLabel } from '../content-overflow';
import {
  formatBindingLabel,
  formatLifecycleBadge,
  formatRuntimeLabel,
  formatSealReason,
} from '../runtime-sessions/external-runtime-session-format';
import type { ExternalRuntimeSessionListItem } from '../runtime-sessions/external-runtime-session-types';

export interface DigestNoiseSummary {
  kind: string;
  count: number;
  sample: string;
  invocationIds: string[];
  firstAt: number;
  lastAt: number;
  outcome: 'recovered' | 'terminal' | string;
}

export function RuntimeMetadataHeader({
  session,
  noise,
}: {
  session: ExternalRuntimeSessionListItem;
  noise: DigestNoiseSummary[];
}) {
  const resolveCatName = useCatTechnicalLabelResolver();
  const t = useTrajectoryCopy(sessionChainCopy);
  const isV2 = useShellPresentation() === 'v2';
  const badge = formatLifecycleBadge(session.lifecycle);
  const latestIdentity = session.identityHistory?.at(-1);
  const model = latestIdentity?.model ?? session.model ?? (isV2 ? t.modelUnknown : 'model unknown');
  const identityLabel = `${resolveCatName(latestIdentity?.catId ?? session.catId)} · ${model}`;

  return (
    <div className="space-y-2 bg-[var(--console-shell-bg)] px-3 py-2 console-divider-b">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-cafe-secondary">{formatRuntimeLabel(session.runtime)}</span>
        <span className={`rounded-md px-1.5 py-0.5 text-micro font-semibold ${badge.className}`}>
          {isV2
            ? ((
                {
                  active: t.working,
                  sealed: t.sealed,
                  runtime_seal_pending: t.sealing,
                  runtime_conflict_pending: t.conflict,
                } as Record<string, string>
              )[session.lifecycle.state] ?? badge.label)
            : badge.label}
        </span>
        {session.lifecycle.sealReason && (
          <span className="text-micro text-cafe-muted">
            {(
              {
                oversized_retire: t.oversized,
                user_initiated: t.resetByUser,
                empty_response: t.emptyResponse,
                tool_conflict: t.toolConflict,
                runtime_disconnected: t.runtimeDisconnected,
              } as Record<string, string>
            )[session.lifecycle.sealReason] ?? formatSealReason(session.lifecycle.sealReason)}
          </span>
        )}
      </div>
      <div className="grid min-w-0 gap-x-3 gap-y-1 text-micro text-cafe-muted sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Cascade</span>
          <CompactLabel
            label="Cascade ID"
            value={session.runtimeSessionId}
            className="min-w-0 flex-1 font-mono text-cafe-secondary"
          />
        </div>
        {session.runtimeConversationId && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{isV2 ? t.conversationLabel : 'Conversation'}</span>
            <CompactLabel
              label={isV2 ? t.conversationIdLabel : 'Conversation ID'}
              value={session.runtimeConversationId}
              className="min-w-0 flex-1 font-mono text-cafe-secondary"
            />
          </div>
        )}
        <CompactLabel label={t.runtimeIdentity} value={identityLabel} className="text-cafe-secondary" />
        <CompactLabel
          label={t.bindingMode}
          value={
            isV2
              ? session.binding.mode === 'orphan_anchor'
                ? t.ide
                : t.threadBinding
              : formatBindingLabel(session.binding)
          }
          className="text-cafe-secondary"
        />
      </div>
      <div className="flex flex-wrap gap-2 text-micro">
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.sessionRecord}>
          {isV2 ? t.recordLink : 'record'}
        </a>
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.events}>
          {isV2 ? t.eventsLink : 'events'}
        </a>
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.digest}>
          {isV2 ? t.digestLink : 'digest'}
        </a>
      </div>
      {noise.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {noise.map((entry) => (
            <span
              key={`${entry.kind}-${entry.firstAt}-${entry.lastAt}`}
              className="rounded-md bg-cafe-surface-elevated px-1.5 py-0.5 text-micro text-cafe-secondary"
              title={entry.sample}
            >
              {isV2 ? (
                t.noiseSummary(entry.kind, entry.count, entry.outcome)
              ) : (
                <>
                  {entry.kind} × {entry.count} · {entry.outcome}
                </>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
