import type { FrustrationSignalType } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { RichBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

const SIGNALS: readonly FrustrationSignalType[] = [
  'cli_error',
  'cancel_burst',
  'text_frustration',
  'a2a_timeout',
  'retry_burst',
  'user_report',
];
export function frustrationSignal(value: unknown): FrustrationSignalType | null {
  return typeof value === 'string' && SIGNALS.includes(value as FrustrationSignalType)
    ? (value as FrustrationSignalType)
    : null;
}
export function isRetiredFrustrationSignal(value: unknown): boolean {
  return value === 'text_frustration' || value === 'retry_burst';
}
export function trustedFrustrationMeta(block: RichBlock, connector?: string) {
  if (connector !== 'frustration-auto-issue' || block.kind !== 'card' || block.meta?.kind !== 'frustration_auto_issue')
    return null;
  return {
    issueId: typeof block.meta.issueId === 'string' ? block.meta.issueId : null,
    signal: frustrationSignal(block.meta.signalType),
  };
}

export function visibleFrustrationBlocks(entries: ReturnType<typeof useFrustrationVisibility>) {
  return entries
    .filter((entry) => entry.visibility !== 'retired')
    .map(({ block, signal }) =>
      signal && block.kind === 'card' ? { ...block, meta: { ...block.meta, signalType: signal } } : block,
    );
}

/** Historical cards are classified by their original issue, never their title or body. */
export function useFrustrationVisibility(blocks: readonly RichBlock[], connector?: string) {
  const legacy = blocks
    .map((block) => trustedFrustrationMeta(block, connector))
    .filter((meta) => meta && !meta.signal && meta.issueId);
  const ids = [...new Set(legacy.map((meta) => meta?.issueId).filter((id): id is string => Boolean(id)))];
  const key = JSON.stringify(ids);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    signals: Record<string, FrustrationSignalType | null>;
  } | null>(null);
  useEffect(() => {
    if (key === '[]') return;
    const controller = new AbortController();
    const issueIds: string[] = JSON.parse(key);
    void Promise.all(
      issueIds.map(async (id) => {
        try {
          const response = await apiFetch(`/api/frustration-issues/${encodeURIComponent(id)}/status`, {
            signal: controller.signal,
          });
          if (!response.ok) return [id, null] as const;
          const body: { issue?: { signalType?: unknown } } = await response.json();
          return [id, frustrationSignal(body.issue?.signalType)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (!controller.signal.aborted) setSnapshot({ key, signals: Object.fromEntries(entries) });
    });
    return () => controller.abort();
  }, [key]);
  const signals = snapshot?.key === key ? snapshot.signals : {};
  return blocks.map((block) => {
    const meta = trustedFrustrationMeta(block, connector);
    const signal = meta?.signal ?? (meta?.issueId ? (signals[meta.issueId] ?? null) : null);
    return {
      block,
      signal,
      visibility: !meta
        ? ('allowed' as const)
        : !signal
          ? ('unknown' as const)
          : isRetiredFrustrationSignal(signal)
            ? ('retired' as const)
            : ('allowed' as const),
    };
  });
}
