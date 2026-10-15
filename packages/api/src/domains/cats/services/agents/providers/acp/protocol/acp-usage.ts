import type { MessageMetadata, TokenUsage } from '../../../../types.js';
import type { AcpPromptResult } from '../types.js';
import { ACP_CONTRACT_META, isAcpRecord } from './acp-capabilities.js';

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** Standard usage_update is a context/session snapshot, never per-prompt spend. */
export function acpContextUsage(
  inner: Record<string, unknown>,
  sessionId: string,
  metadata: MessageMetadata,
): MessageMetadata | null {
  const usage: TokenUsage = {};
  if (valid(inner.used)) usage.contextUsedTokens = inner.used;
  if (valid(inner.size) && inner.size > 0) usage.contextWindowSize = inner.size;
  const cost =
    isAcpRecord(inner.cost) &&
    valid(inner.cost.amount) &&
    typeof inner.cost.currency === 'string' &&
    /^[A-Z]{3}$/.test(inner.cost.currency)
      ? { amount: inner.cost.amount, currency: inner.cost.currency, scope: 'session', kind: 'snapshot' }
      : undefined;
  if (Object.keys(usage).length === 0 && !cost) return null;
  return {
    ...metadata,
    ...(Object.keys(usage).length ? { usage } : {}),
    diagnostics: {
      ...metadata.diagnostics,
      acpUsage: {
        source: 'acp.usage_update',
        sessionId,
        scope: 'context',
        kind: 'snapshot',
        unit: 'tokens',
        observedAt: Date.now(),
        verification: 'bridge_reported',
        ...(cost ? { cost } : {}),
      },
    },
  };
}
/** One tracker per invocation. Unknown experimental token scope stays raw instead of becoming spend. */
export class AcpPromptUsageTracker {
  private readonly deltas = new Set<string>();
  private totals: TokenUsage = {};
  private sessionId?: string;
  private negotiated = false;
  bind(sessionId: string, negotiated: boolean): void {
    if (this.sessionId !== sessionId || this.negotiated !== negotiated) {
      this.deltas.clear();
      this.totals = {};
    }
    this.sessionId = sessionId;
    this.negotiated = negotiated;
  }
  accept(result: AcpPromptResult): { usage?: TokenUsage; scope: string; kind: string } {
    const raw = isAcpRecord(result.usage) ? result.usage : undefined;
    const ns = isAcpRecord(result._meta?.[ACP_CONTRACT_META]) ? result._meta[ACP_CONTRACT_META] : undefined;
    const meter = isAcpRecord(ns) && isAcpRecord(ns.usage) ? ns.usage : undefined;
    if (!this.negotiated || !raw || meter?.scope !== 'prompt' || (meter.kind !== 'snapshot' && meter.kind !== 'delta'))
      return { scope: 'unknown', kind: 'unknown' };
    if (meter.kind === 'snapshot') this.totals = {};
    if (meter.kind === 'delta') {
      if (typeof meter.id !== 'string' || !meter.id) return { scope: 'unknown', kind: 'delta_without_id' };
      if (this.deltas.has(meter.id)) return { usage: { ...this.totals }, scope: 'prompt', kind: 'duplicate_delta' };
      this.deltas.add(meter.id);
    }
    for (const [native, key] of [
      ['inputTokens', 'inputTokens'],
      ['outputTokens', 'outputTokens'],
      ['totalTokens', 'totalTokens'],
      ['cachedReadTokens', 'cacheReadTokens'],
      ['cachedWriteTokens', 'cacheCreationTokens'],
    ] as const) {
      if (valid(raw[native]))
        this.totals[key] = meter.kind === 'delta' ? (this.totals[key] ?? 0) + raw[native] : raw[native];
    }
    return { usage: { ...this.totals }, scope: 'prompt', kind: meter.kind };
  }
}
