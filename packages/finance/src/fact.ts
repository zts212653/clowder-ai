import { createHash } from 'node:crypto';
import type {
  CreateFinanceFactInput,
  FinanceFactEnvelope,
  FinancePresentationHint,
  FinanceSnapshotInput,
} from './types.js';

const DEFAULT_PRESENTATION_HINT: FinancePresentationHint = {
  detailLevel: 'compact',
  compactSummary: true,
  avoidWords: ['紧急', '立刻', '马上买', '马上卖'],
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function createSnapshotId(input: FinanceSnapshotInput): string {
  const hash = createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 24);
  return `fin_${hash}`;
}

export function createFinanceFact<TData>(input: CreateFinanceFactInput<TData>): FinanceFactEnvelope<TData> {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const snapshot_id = createSnapshotId({
    provider: input.provider,
    source: input.source,
    asOf: input.asOf,
    query: input.query,
    data: input.data,
  });

  let queriesInLast7Days = 0;
  if (input.frequencyTracker && input.frequencyKey) {
    input.frequencyTracker.record(input.frequencyKey, new Date(fetchedAt));
    queriesInLast7Days = input.frequencyTracker.countLast7Days(input.frequencyKey, new Date(fetchedAt));
  }

  return {
    snapshot_id,
    provider: input.provider,
    source: input.source,
    sourceTier: input.sourceTier,
    asOf: input.asOf,
    fetchedAt,
    confidence: input.confidence,
    query: input.query,
    data: input.data,
    presentationHint: {
      ...DEFAULT_PRESENTATION_HINT,
      ...input.presentationHint,
    },
    queriesInLast7Days,
  };
}
