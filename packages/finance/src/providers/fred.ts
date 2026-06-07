import { createFinanceFact } from '../fact.js';
import type { FinanceFactEnvelope, FinanceProviderAdapter, QueryFrequencyCounter } from '../types.js';

export const FRED_OBSERVATIONS_URL = 'https://api.stlouisfed.org/fred/series/observations';

export interface FredQueryRequest {
  readonly seriesId: string;
  readonly observationStart?: string;
  readonly observationEnd?: string;
  readonly frequencyKey?: string;
}

interface FredProviderOptions {
  readonly apiKey?: string;
  readonly observationsUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly frequencyTracker?: QueryFrequencyCounter;
}

interface FredObservation {
  readonly date: string;
  readonly value: string;
}

export class FredProvider
  implements
    FinanceProviderAdapter<
      FredQueryRequest,
      { observations: FredObservation[]; latest: { date: string; value: number } }
    >
{
  readonly provider = 'fred' as const;
  private readonly apiKey: string;
  private readonly observationsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly frequencyTracker?: QueryFrequencyCounter;

  constructor(options: FredProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['FRED_API_KEY'] ?? '';
    this.observationsUrl = options.observationsUrl ?? FRED_OBSERVATIONS_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.frequencyTracker = options.frequencyTracker;
  }

  async query(
    request: FredQueryRequest,
  ): Promise<FinanceFactEnvelope<{ observations: FredObservation[]; latest: { date: string; value: number } }>> {
    if (!this.apiKey) {
      throw new Error('FRED_API_KEY is required for FRED provider queries');
    }

    const url = new URL(this.observationsUrl);
    url.searchParams.set('series_id', request.seriesId);
    url.searchParams.set('file_type', 'json');
    // FRED's official API requires api_key as a query parameter; never persist the request URL in facts.
    url.searchParams.set('api_key', this.apiKey);
    if (request.observationStart) url.searchParams.set('observation_start', request.observationStart);
    if (request.observationEnd) url.searchParams.set('observation_end', request.observationEnd);

    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`FRED HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const payload = (await response.json()) as { observations?: FredObservation[] };
    const observations = (payload.observations ?? []).filter((item) => item.value !== '.');
    const latest = observations.at(-1);
    if (!latest) {
      throw new Error(`FRED returned no observations for ${request.seriesId}`);
    }

    const data = {
      observations,
      latest: {
        date: latest.date,
        value: Number(latest.value),
      },
    };

    return createFinanceFact({
      provider: this.provider,
      source: `FRED:${request.seriesId}`,
      sourceTier: 'official',
      asOf: latest.date,
      confidence: 'high',
      query: {
        seriesId: request.seriesId,
        observationStart: request.observationStart,
        observationEnd: request.observationEnd,
      },
      data,
      frequencyTracker: this.frequencyTracker,
      frequencyKey: request.frequencyKey ?? `fred:${request.seriesId}`,
    });
  }
}
