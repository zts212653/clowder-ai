import { canonicalJson, createFinanceFact } from '../fact.js';
import type { FinanceFactEnvelope, FinanceProviderAdapter, QueryFrequencyCounter } from '../types.js';

export const TTFUND_GATEWAY_URL = 'https://skills.tiantianfunds.com/ai-smart-skill-service/openapi/skill/invoke';

const TTFUND_SKILL_VERSIONS: Record<string, string> = {
  FUND_BASE_INFOS: '1.2.0',
  FUND_MANAGER_INFO: '1.0.0',
  FUND_CONDITION_SELECT: '1.1.0',
  FUND_HOLDING_INFO: '1.0.0',
  FUND_HUAAN_GOLD_INFO: '1.0.0',
  FUND_TG_STRATEGY_INFO: '1.0.0',
  FUND_INDEX_INFO: '1.0.0',
  FUND_NAV_INFO: '1.0.0',
  MODEL_PORTFOLIO: '1.0.0',
  FUND_FAVOR_ZX: '1.2.0',
  BOND_MARKET: '1.0.0',
  FUND_GROUP_BACKTEST: '1.0.0',
  FUND_SEARCH: '1.0.0',
  FUND_STOCK_PRICE_QUERY: '1.0.0',
  FUND_THEME_INFO: '1.0.0',
  FUND_HUOQIBAO_LIST: '1.0.0',
};

export interface TTFundQueryRequest {
  readonly skillId: keyof typeof TTFUND_SKILL_VERSIONS | string;
  readonly payload?: Record<string, unknown>;
  readonly asOf: string;
  readonly fetchedAt?: string;
  readonly frequencyKey?: string;
}

interface TTFundProviderOptions {
  readonly apiKey?: string;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly frequencyTracker?: QueryFrequencyCounter;
}

function isCredentialLikeKey(key: string): boolean {
  const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return (
    normalizedKey === 'authorization' ||
    normalizedKey.includes('apikey') ||
    normalizedKey.endsWith('token') ||
    normalizedKey.endsWith('secret') ||
    normalizedKey.endsWith('password')
  );
}

function assertNoCredentialLikePayloadKeys(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialLikePayloadKeys(item, [...path, String(index)]));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialLikeKey(key)) {
      throw new Error(`TTFund payload contains credential-like field: ${[...path, key].join('.')}`);
    }
    assertNoCredentialLikePayloadKeys(nestedValue, [...path, key]);
  }
}

function createTTFundFrequencyKey(skillId: string, payload: Record<string, unknown>): string {
  return `ttfund:${skillId}:${canonicalJson(payload)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSuccessCode(value: unknown): boolean {
  return value === 0 || value === '0' || value === 200 || value === '200';
}

function asMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'unknown';
}

function assertSuccessfulTTFundEnvelope(data: unknown): void {
  if (!isRecord(data)) {
    throw new Error('TTFund gateway response must be a JSON object');
  }

  if (data['code'] === undefined) {
    throw new Error('TTFund gateway response missing explicit success code');
  }

  if (!isSuccessCode(data['code'])) {
    throw new Error(
      `TTFund gateway application failure: code=${asMessage(data['code'])} message=${asMessage(data['message'])}`,
    );
  }

  const rawResult = isRecord(data['data']) ? data['data']['raw_result'] : undefined;
  if (!isRecord(rawResult)) {
    return;
  }

  if (rawResult['status_code'] === undefined) {
    throw new Error('TTFund raw_result missing explicit status_code');
  }

  if (!isSuccessCode(rawResult['status_code'])) {
    throw new Error(`TTFund raw_result failure: status_code=${asMessage(rawResult['status_code'])}`);
  }

  const rawBody = rawResult['body'];
  if (isRecord(rawBody) && rawBody['success'] === false) {
    throw new Error(`TTFund raw_result failure: success=false message=${asMessage(rawBody['message'])}`);
  }
}

export class TTFundProvider implements FinanceProviderAdapter<TTFundQueryRequest> {
  readonly provider = 'ttfund' as const;
  private readonly apiKey: string;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly frequencyTracker?: QueryFrequencyCounter;

  constructor(options: TTFundProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['TTFUND_APIKEY'] ?? '';
    this.gatewayUrl = options.gatewayUrl ?? TTFUND_GATEWAY_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.frequencyTracker = options.frequencyTracker;
  }

  async query(request: TTFundQueryRequest): Promise<FinanceFactEnvelope> {
    if (!this.apiKey) {
      throw new Error('Missing TTFUND_APIKEY');
    }

    const asOf = request.asOf?.trim();
    if (!asOf) {
      throw new Error('TTFund query requires source asOf; do not stamp facts with wall-clock freshness');
    }

    const payload = request.payload ?? {};
    assertNoCredentialLikePayloadKeys(payload);

    const version = TTFUND_SKILL_VERSIONS[request.skillId] ?? '1.0.0';
    const body = {
      ...payload,
      skill_id: request.skillId,
      _skill_version: version,
    };

    const response = await this.fetchImpl(this.gatewayUrl, {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      }),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`TTFund gateway HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = (await response.json()) as unknown;
    assertSuccessfulTTFundEnvelope(data);

    return createFinanceFact({
      provider: this.provider,
      source: request.skillId,
      sourceTier: 'official-gateway',
      asOf,
      fetchedAt: request.fetchedAt,
      confidence: 'high',
      query: {
        skillId: request.skillId,
        payload,
      },
      data,
      frequencyTracker: this.frequencyTracker,
      frequencyKey: request.frequencyKey ?? createTTFundFrequencyKey(request.skillId, payload),
    });
  }
}
