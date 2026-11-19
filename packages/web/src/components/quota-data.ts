// --- Types (mirror backend QuotaResponse) ---

export interface CcusageBillingBlock {
  id: string;
  startTime: string;
  endTime: string;
  isActive: boolean;
  isGap: boolean;
  entries: number;
  totalTokens: number;
  costUSD: number;
  models: string[];
  burnRate: { tokensPerMinute: number; costPerHour: number } | null;
  projection: {
    totalTokens: number;
    totalCost: number;
    remainingMinutes: number;
  } | null;
}

export interface ClaudeQuota {
  platform: 'claude';
  activeBlock: CcusageBillingBlock | null;
  usageItems?: CodexUsageItem[];
  recentBlocks: CcusageBillingBlock[];
  officialError?: string;
  cliError?: string;
  error?: string;
  lastChecked: string | null;
}

export interface CodexUsageItem {
  label: string;
  usedPercent: number;
  percentKind?: 'used' | 'remaining';
  poolId?: string;
  resetsAt?: string;
  resetsText?: string;
}

export interface CodexQuota {
  platform: 'codex';
  usageItems: CodexUsageItem[];
  error?: string;
  lastChecked: string | null;
}

export interface GeminiQuota {
  platform: 'gemini';
  usageItems: CodexUsageItem[];
  error?: string;
  lastChecked: string | null;
}

export interface KimiQuota {
  platform: 'kimi';
  usageItems: CodexUsageItem[];
  error?: string;
  lastChecked: string | null;
  status?: 'ok' | 'unavailable';
  note?: string;
}

export interface AntigravityQuota {
  platform: 'antigravity';
  usageItems: CodexUsageItem[];
  error?: string;
  lastChecked: string | null;
}

export interface QuotaResponse {
  claude: ClaudeQuota;
  codex: CodexQuota;
  gemini: GeminiQuota;
  kimi: KimiQuota;
  antigravity: AntigravityQuota;
  fetchedAt: string;
}

// --- Pool grouping ---

export interface PoolGroup {
  poolId: string;
  displayName: string;
  items: CodexUsageItem[];
}

const CODEX_POOL_DISPLAY: Record<string, string> = {
  'codex-main': '缅因猫 Codex + GPT-5.2',
  'codex-spark': '缅因猫 Spark',
  'codex-review': '缅因猫 代码审查',
  'codex-overflow': '溢出额度',
};

export function groupCodexByPool(items: CodexUsageItem[]): PoolGroup[] {
  const map = new Map<string, CodexUsageItem[]>();
  for (const item of items) {
    const id = item.poolId ?? 'codex-unknown';
    const arr = map.get(id) ?? [];
    arr.push(item);
    map.set(id, arr);
  }
  const order = ['codex-main', 'codex-spark', 'codex-review', 'codex-overflow'];
  const result: PoolGroup[] = [];
  for (const poolId of order) {
    const poolItems = map.get(poolId);
    if (poolItems) {
      result.push({
        poolId,
        displayName: CODEX_POOL_DISPLAY[poolId] ?? poolId,
        items: poolItems,
      });
      map.delete(poolId);
    }
  }
  for (const [poolId, poolItems] of map) {
    result.push({ poolId, displayName: CODEX_POOL_DISPLAY[poolId] ?? poolId, items: poolItems });
  }
  return result;
}

// --- Risk & display helpers ---

/** Returns utilization 0-100 (how much is USED). */
export function toUtilization(item: CodexUsageItem): number {
  return item.percentKind === 'remaining' ? 100 - item.usedPercent : item.usedPercent;
}
