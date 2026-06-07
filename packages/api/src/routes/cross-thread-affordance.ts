import type { SuggestedCrossPostAction, SuggestedCrossPostActionSource } from '@cat-cafe/shared';
import type { EvidenceDrillDown } from '../domains/memory/interfaces.js';

export function buildThreadCrossPostSuggestion(
  threadId: string | undefined,
  currentThreadId: string | undefined,
  source: SuggestedCrossPostActionSource,
  reason: string,
): SuggestedCrossPostAction | undefined {
  const target = threadId?.trim();
  const current = currentThreadId?.trim();
  if (!target || !current || target === current) return undefined;
  return {
    type: 'cross_post',
    threadId: target,
    reason,
    source,
  };
}

export function extractThreadIdFromEvidenceResult(input: {
  passages?: Array<{ threadId?: string; context?: Array<{ threadId?: string }> }>;
  drillDown?: EvidenceDrillDown;
  anchor?: string;
}): string | undefined {
  for (const passage of input.passages ?? []) {
    if (passage.threadId) return passage.threadId;
    for (const context of passage.context ?? []) {
      if (context.threadId) return context.threadId;
    }
  }
  const drillThreadId = input.drillDown?.params?.threadId;
  if (drillThreadId) return drillThreadId;
  return extractThreadIdFromRecentAnchor(input.anchor);
}

export function extractThreadIdFromRecentAnchor(anchor: string | undefined): string | undefined {
  const trimmed = anchor?.trim();
  if (!trimmed) return undefined;
  const colonMatch = trimmed.match(/^thread:(.+)$/);
  if (colonMatch) return colonMatch[1]?.trim() || undefined;
  // evidence_docs stores thread anchors as `thread-${threadId}`. Real thread IDs
  // may themselves start with `thread_` or `thread-`, so remove exactly one
  // synthetic anchor prefix.
  if (trimmed.startsWith('thread-')) {
    return trimmed.slice('thread-'.length).trim() || undefined;
  }
  if (trimmed.startsWith('thread_')) return trimmed;
  return undefined;
}
