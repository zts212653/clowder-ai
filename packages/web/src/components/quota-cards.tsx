// biome-ignore lint/correctness/noUnusedImports: React must be in scope for SSR JSX runtime in tests.
import React from 'react';

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

export function riskDotClass(utilization: number): string {
  if (utilization >= 80) return 'text-rose-500';
  if (utilization >= 50) return 'text-amber-500';
  return 'text-emerald-500';
}

function barColor(utilization: number): string {
  if (utilization >= 80) return 'bg-rose-500';
  if (utilization >= 50) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function formatPercent(item: CodexUsageItem): string {
  if (item.percentKind === 'remaining') return `${item.usedPercent}% 剩余`;
  return `${item.usedPercent}% 已用`;
}

export function degradationHint(poolId: string | undefined, utilization: number): string | null {
  if (utilization < 80) return null;
  switch (poolId) {
    case 'claude-session':
    case 'claude-weekly-all':
      return 'Opus 额度紧张，建议降级 Sonnet 或推迟重活';
    case 'claude-weekly-sonnet':
      return 'Sonnet 额度也紧张，考虑切到缅因猫';
    case 'codex-main':
      return '编码额度紧张，建议切到 @spark';
    case 'codex-spark':
      return 'Spark 额度紧张，仅剩 @gpt52 可用';
    case 'codex-review':
      return 'Review 额度紧张，建议切到 @gpt52 review';
    case 'gemini-pro':
      return 'Gemini Pro 额度紧张，建议切到 Flash';
    case 'gemini-flash':
      return 'Gemini Flash 额度也紧张';
    default:
      return null;
  }
}

// --- Components ---

function ProgressBar({ percent, utilization }: { percent: number; utilization: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const color = barColor(utilization);
  return (
    <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function QuotaPoolRow({ item }: { item: CodexUsageItem }) {
  const utilization = toUtilization(item);
  const dot = riskDotClass(utilization);
  const hint = degradationHint(item.poolId, utilization);
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-sm ${dot}`} aria-hidden="true">
            {'\u25CF'}
          </span>
          <span className="text-sm text-cafe-secondary truncate">{item.label}</span>
        </div>
        <span
          className={`text-sm font-semibold whitespace-nowrap ${utilization >= 80 ? 'text-rose-600' : 'text-cafe'}`}
        >
          {formatPercent(item)}
        </span>
      </div>
      <div className="mt-1 ml-5">
        <ProgressBar
          percent={item.percentKind === 'remaining' ? item.usedPercent : 100 - item.usedPercent}
          utilization={utilization}
        />
      </div>
      {(item.resetsText || item.resetsAt) && (
        <div className="mt-0.5 ml-5 text-xs text-cafe-muted">
          {item.resetsText ?? `resets ${new Date(item.resetsAt!).toLocaleString()}`}
        </div>
      )}
      {hint && <div className="mt-0.5 ml-5 text-xs text-amber-600">{hint}</div>}
    </div>
  );
}
