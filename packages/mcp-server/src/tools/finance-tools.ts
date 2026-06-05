import {
  type FinanceFactEnvelope,
  FredProvider,
  type FredQueryRequest,
  QueryFrequencyTracker,
  TTFundProvider,
  type TTFundQueryRequest,
} from '@cat-cafe/finance';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const READ_ONLY_TTFUND_SKILLS = new Set([
  'FUND_BASE_INFOS',
  'FUND_MANAGER_INFO',
  'FUND_CONDITION_SELECT',
  'FUND_HOLDING_INFO',
  'FUND_HUAAN_GOLD_INFO',
  'FUND_TG_STRATEGY_INFO',
  'FUND_INDEX_INFO',
  'FUND_NAV_INFO',
  'BOND_MARKET',
  'FUND_SEARCH',
  'FUND_STOCK_PRICE_QUERY',
  'FUND_THEME_INFO',
  'FUND_HUOQIBAO_LIST',
]);

const defaultFrequencyTracker = new QueryFrequencyTracker();

export const financeQueryInputSchema = {
  provider: z.enum(['ttfund', 'fred']).describe('Finance data provider to query through cat-cafe-finance.'),
  ttfund: z
    .object({
      skillId: z.string().min(1).describe('Read-only Tiantian Fund skill id, such as FUND_SEARCH or FUND_NAV_INFO.'),
      payload: z
        .record(z.unknown())
        .optional()
        .describe('Provider request payload. API credentials are never accepted here.'),
      asOf: z
        .string()
        .min(1)
        .describe('Required source asOf date. TTFund facts must not use wall-clock freshness as a fallback.'),
    })
    .optional()
    .describe('Tiantian Fund official Skills gateway request.'),
  fred: z
    .object({
      seriesId: z.string().min(1).describe('FRED series id, such as CPIAUCSL or DGS10.'),
      observationStart: z.string().optional().describe('Optional observation_start date.'),
      observationEnd: z.string().optional().describe('Optional observation_end date.'),
    })
    .optional()
    .describe('FRED observations request.'),
};

type PublicTTFundQueryInput = Omit<TTFundQueryRequest, 'frequencyKey'> & {
  readonly frequencyKey?: string;
};

type PublicFredQueryInput = Omit<FredQueryRequest, 'frequencyKey'> & {
  readonly frequencyKey?: string;
};

type ProviderLike<TRequest> = {
  query(request: TRequest): Promise<FinanceFactEnvelope>;
};

type FinanceQueryInput = {
  provider: 'ttfund' | 'fred';
  ttfund?: PublicTTFundQueryInput;
  fred?: PublicFredQueryInput;
};

interface FinanceQueryHandlerOptions {
  readonly ttfundProvider?: ProviderLike<TTFundQueryRequest>;
  readonly fredProvider?: ProviderLike<FredQueryRequest>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReadOnlyTTFundSkill(skillId: string): void {
  if (!READ_ONLY_TTFUND_SKILLS.has(skillId)) {
    throw new Error(`TTFund skill "${skillId}" is not allowed through the read-only finance wrapper`);
  }
}

function stripTTFundPublicOverrides(request: PublicTTFundQueryInput): TTFundQueryRequest {
  const { frequencyKey: _ignoredFrequencyKey, ...derivedRequest } = request;
  return derivedRequest;
}

function stripFredPublicOverrides(request: PublicFredQueryInput): FredQueryRequest {
  const { frequencyKey: _ignoredFrequencyKey, ...derivedRequest } = request;
  return derivedRequest;
}

export function createFinanceQueryHandler(options: FinanceQueryHandlerOptions = {}) {
  return async function handleFinanceQuery(input: FinanceQueryInput): Promise<ToolResult> {
    try {
      if (input.provider === 'ttfund') {
        if (!input.ttfund) {
          throw new Error('Missing ttfund request payload');
        }
        assertReadOnlyTTFundSkill(input.ttfund.skillId);
        const provider = options.ttfundProvider ?? new TTFundProvider({ frequencyTracker: defaultFrequencyTracker });
        const fact = await provider.query(stripTTFundPublicOverrides(input.ttfund));
        return successResult(JSON.stringify(fact, null, 2));
      }

      if (!input.fred) {
        throw new Error('Missing fred request payload');
      }
      const provider = options.fredProvider ?? new FredProvider({ frequencyTracker: defaultFrequencyTracker });
      const fact = await provider.query(stripFredPublicOverrides(input.fred));
      return successResult(JSON.stringify(fact, null, 2));
    } catch (error) {
      return errorResult(`Finance query failed: ${errorMessage(error)}`);
    }
  };
}

export const handleFinanceQuery = createFinanceQueryHandler();

export const financeTools = [
  {
    name: 'cat_cafe_finance_query',
    description:
      'Query normalized personal-finance facts through the read-only cat-cafe-finance wrapper. Returns source/asOf/confidence/snapshot_id/presentationHint metadata. Does not expose buy, sell, transfer, or raw provider credential operations.',
    inputSchema: financeQueryInputSchema,
    handler: handleFinanceQuery,
  },
];
