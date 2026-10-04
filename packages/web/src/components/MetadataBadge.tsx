'use client';

import { useState } from 'react';
import type { ChatMessageMetadata } from '@/stores/chatStore';
import { formatCost, formatTokenCount } from './status-helpers';

interface MetadataBadgeProps {
  metadata: ChatMessageMetadata;
}

function cachePercent(input?: number, cacheRead?: number): number | null {
  if (!cacheRead || !input) return null;
  return Math.round((cacheRead / input) * 100);
}

/**
 * F319 Phase E: three raw facts per observed turn, none of them a verdict.
 * ① the upstream's self-declared model (`response.model`) — consistent → light ✓, different → `A → B`;
 * ② the turn-state token length, shown even when missing ("未观测" is its own state, never folded away);
 * ③ the wording says "self-declared", never "verified" — nothing here checks the weights.
 * Messages without `servedModel` were not observed at all and render exactly as before F319.
 */
function turnStateFact(length: number | undefined): { text: string; attr: string } {
  if (typeof length === 'number' && Number.isFinite(length))
    return { text: `turn-state ${length}`, attr: String(length) };
  return { text: 'turn-state 未观测', attr: 'unobserved' };
}

/** Warning triangle sized for the micro badge text; decorative (the pill text carries the meaning). */
function RerouteWarningIcon() {
  return (
    <svg
      data-icon="reroute-warning"
      aria-hidden="true"
      className="mr-0.5 h-3 w-3 flex-shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ModelLabel({ metadata }: MetadataBadgeProps) {
  const requested = metadata.model || 'unknown';
  const provider = metadata.provider || 'unknown';
  const served = metadata.servedModel?.trim();
  if (!served) {
    return (
      <span>
        {requested} · {provider}
      </span>
    );
  }
  const requestedModel = metadata.model?.trim();
  const turnState = turnStateFact(metadata.upstreamTurnStateLength);
  const turnStateSpan = (
    <span className="whitespace-nowrap text-cafe-muted" data-turn-state={turnState.attr}>
      {' '}
      · {turnState.text}
    </span>
  );
  // No requested model = nothing to compare against: report what the upstream said, never a ✓.
  if (!requestedModel) {
    return (
      <span
        data-served-model={served}
        title={`上游自述 ${served}（response.model，非权重验证）· 请求模型未知 · ${turnState.text}`}
      >
        unknown · {provider}
        {turnStateSpan}
      </span>
    );
  }
  const servedDiffers = served.toLowerCase() !== requestedModel.toLowerCase();
  if (!servedDiffers) {
    return (
      <span
        data-served-model={served}
        data-served-consistent="true"
        title={`上游自述一致（response.model，非权重验证）· ${turnState.text}`}
      >
        {requested} · {provider}
        <span className="ml-0.5 text-conn-emerald-text/80">✓</span>
        {turnStateSpan}
      </span>
    );
  }
  const responseRef = metadata.servedResponseId ? `上游 response ${metadata.servedResponseId} ` : '上游';
  return (
    <span
      className="text-left text-conn-amber-text"
      data-served-model={served}
      title={`${responseRef}自述的模型与请求不同（response.model，非权重验证）· ${turnState.text}`}
    >
      {requested} → {served}（上游应答）
      {/* F319 Phase F: the reroute warning lives on the reply it describes (persisted metadata,
          survives reload) instead of a detached live-only info banner. */}
      <span
        data-served-reroute="true"
        className="mx-1 inline-flex items-center whitespace-nowrap rounded-full border border-conn-amber-ring bg-conn-amber-bg px-1.5 font-medium text-conn-amber-text"
        title={`请求 ${requestedModel}，上游实际应答 ${served}${
          metadata.servedResponseId ? ` · response ${metadata.servedResponseId}` : ''
        }（上游自述，非权重验证）`}
      >
        <RerouteWarningIcon />
        上游换模
      </span>
      <span className="whitespace-nowrap">· {provider}</span>
      {turnStateSpan}
    </span>
  );
}

export function MetadataBadge({ metadata }: MetadataBadgeProps) {
  const [expanded, setExpanded] = useState(false);

  // Read usage from message metadata (message-scoped, not per-cat aggregate)
  const usage = metadata.usage;

  const hasTokens = usage && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null);
  const cachePct = usage ? cachePercent(usage.inputTokens, usage.cacheReadTokens) : null;

  const badge = (
    <button
      type="button"
      data-testid="message-metadata"
      onClick={() => setExpanded((v) => !v)}
      className="mt-1 text-micro text-cafe-muted hover:text-cafe-secondary transition-colors cursor-pointer select-none flex items-center gap-0 flex-wrap text-left"
    >
      <ModelLabel metadata={metadata} />

      {hasTokens && (
        <span className="ml-1 animate-fade-in">
          <span className="text-cafe-muted"> · </span>
          {usage.inputTokens != null && (
            <span className="tabular-nums">
              {formatTokenCount(usage.inputTokens)}
              <span className="text-cafe-muted">↓</span>
            </span>
          )}
          {usage.outputTokens != null && (
            <span className="tabular-nums ml-0.5">
              {formatTokenCount(usage.outputTokens)}
              <span className="text-cafe-muted">↑</span>
            </span>
          )}
          {!usage.inputTokens && !usage.outputTokens && usage.totalTokens != null && (
            <span className="tabular-nums">
              {formatTokenCount(usage.totalTokens)}
              <span className="text-cafe-muted">tok</span>
            </span>
          )}
          {cachePct != null && cachePct > 0 && (
            <>
              <span className="text-cafe-muted"> · </span>
              <span className="text-conn-emerald-text/80 tabular-nums">cached {cachePct}%</span>
            </>
          )}
          {usage.costUsd != null && (
            <>
              <span className="text-cafe-muted"> · </span>
              <span
                className="text-conn-amber-text animate-cost-glow tabular-nums"
                title={usage.costEstimated ? '估算值 (基于定价表)' : undefined}
              >
                {usage.costEstimated ? '~' : ''}
                {formatCost(usage.costUsd)}
              </span>
            </>
          )}
        </span>
      )}

      {expanded && metadata.sessionId && (
        <span className="ml-1 text-cafe-muted">· {metadata.sessionId.slice(0, 12)}...</span>
      )}
      {/* F319 Phase F: full response id, selectable, for provider support lookups. */}
    </button>
  );

  // F319 Phase F: the full response id sits OUTSIDE the <button> — text inside a button is not
  // selectable in Chromium even with user-select:text (verified in browser), so it could not be copied.
  if (!expanded || !metadata.servedResponseId) return badge;
  return (
    <div className="flex flex-wrap items-center">
      {badge}
      <span
        className="mt-1 ml-1 text-micro text-cafe-muted select-text cursor-text break-all"
        data-served-response-id={metadata.servedResponseId}
      >
        response {metadata.servedResponseId}
      </span>
    </div>
  );
}
