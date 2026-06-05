export type FinanceProviderId = 'ttfund' | 'fred';

export type FinanceSourceTier = 'official' | 'official-gateway' | 'community-wrapper' | 'derived';

export type FinanceConfidence = 'high' | 'medium' | 'low';

export interface FinancePresentationHint {
  readonly detailLevel: 'compact' | 'standard' | 'expanded';
  readonly compactSummary: boolean;
  readonly avoidWords: readonly string[];
}

export interface FinanceFactEnvelope<TData = unknown> {
  readonly snapshot_id: string;
  readonly provider: FinanceProviderId;
  readonly source: string;
  readonly sourceTier: FinanceSourceTier;
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly confidence: FinanceConfidence;
  readonly query: Record<string, unknown>;
  readonly data: TData;
  readonly presentationHint: FinancePresentationHint;
  readonly queriesInLast7Days: number;
}

export interface FinanceSnapshotInput {
  readonly provider: FinanceProviderId;
  readonly source: string;
  readonly asOf: string;
  readonly query: Record<string, unknown>;
  readonly data: unknown;
}

export interface CreateFinanceFactInput<TData = unknown> extends FinanceSnapshotInput {
  readonly data: TData;
  readonly sourceTier: FinanceSourceTier;
  readonly fetchedAt?: string;
  readonly confidence: FinanceConfidence;
  readonly frequencyTracker?: QueryFrequencyCounter;
  readonly frequencyKey?: string;
  readonly presentationHint?: Partial<FinancePresentationHint>;
}

export interface QueryFrequencyCounter {
  record(key: string, at?: Date): void;
  countLast7Days(key: string, now?: Date): number;
}

export interface FinanceProviderAdapter<TRequest, TData = unknown> {
  readonly provider: FinanceProviderId;
  query(request: TRequest): Promise<FinanceFactEnvelope<TData>>;
}

export interface NormalizedFinanceError {
  readonly kind: 'rate_limited' | 'not_entitled' | 'source_down' | 'schema_drift' | 'no_data' | 'invalid_request';
  readonly provider: FinanceProviderId;
  readonly message: string;
  readonly cause?: unknown;
}
