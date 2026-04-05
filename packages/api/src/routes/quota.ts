/**
 * Quota Route — F051 真实猫粮额度 API
 *
 * 数据源（v3 对齐 ClaudeBar）：
 * 1. Claude: Anthropic OAuth API（/api/oauth/usage）+ ccusage CLI fallback
 * 2. Codex: OpenAI Wham API（/backend-api/wham/usage）+ PATCH 推送 fallback
 * 3. Gemini: Google internal API + PATCH 推送 fallback
 * 4. Antigravity: 本地 Language Server RPC + PATCH 推送 fallback
 *
 * 硬约束：看板值 = 官方 API 值，不二次换算。获取失败显示"获取失败"。
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// --- Types ---

/** ccusage blocks --json 的单个 billing block */
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

export type QuotaProbeTargetPlatform = 'claude' | 'codex' | 'kimi' | 'antigravity';
export type QuotaProbeRuntimeStatus = 'ok' | 'error' | 'disabled';

export interface QuotaProbeAction {
  kind: 'refresh';
  method: 'POST';
  path: `/api/quota/refresh/${string}`;
  requiresInteractive: boolean;
}

export interface QuotaProbeDescriptor {
  id: 'claude-cli' | 'official-browser' | 'kimi-official-web' | 'antigravity-placeholder';
  sourceKind: 'cli' | 'browser' | 'placeholder';
  refreshMode: 'manual' | 'scheduled';
  enabled: boolean;
  status: QuotaProbeRuntimeStatus;
  targets: QuotaProbeTargetPlatform[];
  actions: QuotaProbeAction[];
  reason: string;
}

export type QuotaRiskLevel = 'ok' | 'warn' | 'high';

export interface QuotaSummaryPlatform {
  id: QuotaProbeTargetPlatform;
  label: string;
  displayPercent: number | null;
  displayKind: 'used' | 'remaining' | null;
  utilizationPercent: number | null;
  status: 'ok' | 'warn' | 'error' | 'pending';
  note: string;
  lastChecked: string | null;
}

export interface QuotaSummaryResponse {
  fetchedAt: string;
  risk: {
    level: QuotaRiskLevel;
    reasons: string[];
    maxUtilization: number | null;
  };
  platforms: {
    codex: QuotaSummaryPlatform;
    claude: QuotaSummaryPlatform;
    kimi: QuotaSummaryPlatform;
    antigravity: QuotaSummaryPlatform;
  };
  probes: {
    official: Pick<QuotaProbeDescriptor, 'enabled' | 'status' | 'reason'>;
    claudeCli: Pick<QuotaProbeDescriptor, 'enabled' | 'status' | 'reason'>;
    kimiOfficial: Pick<QuotaProbeDescriptor, 'enabled' | 'status' | 'reason'>;
  };
  actions: {
    refreshOfficialPath: '/api/quota/refresh/official';
    refreshClaudePath: '/api/quota/refresh/claude';
    refreshKimiPath: '/api/quota/refresh/kimi';
  };
}

// --- In-memory cache ---

function createInitialClaudeCache(): ClaudeQuota {
  return {
    platform: 'claude',
    activeBlock: null,
    recentBlocks: [],
    lastChecked: null,
  };
}

function createInitialCodexCache(): CodexQuota {
  return {
    platform: 'codex',
    usageItems: [],
    lastChecked: null,
  };
}

function createInitialGeminiCache(): GeminiQuota {
  return {
    platform: 'gemini',
    usageItems: [],
    lastChecked: null,
  };
}

function createInitialKimiCache(): KimiQuota {
  return {
    platform: 'kimi',
    usageItems: [],
    lastChecked: null,
    status: 'unavailable',
    note: '暂无 Kimi 官方额度数据，请先手动获取。',
  };
}

function createInitialAntigravityCache(): AntigravityQuota {
  return {
    platform: 'antigravity',
    usageItems: [],
    lastChecked: null,
  };
}

let claudeCache: ClaudeQuota = createInitialClaudeCache();
let codexCache: CodexQuota = createInitialCodexCache();
let geminiCache: GeminiQuota = createInitialGeminiCache();
let kimiCache: KimiQuota = createInitialKimiCache();
let antigravityCache: AntigravityQuota = createInitialAntigravityCache();

export function resetQuotaCachesForTests(): void {
  claudeCache = createInitialClaudeCache();
  codexCache = createInitialCodexCache();
  geminiCache = createInitialGeminiCache();
  kimiCache = createInitialKimiCache();
  antigravityCache = createInitialAntigravityCache();
}

const OFFICIAL_REFRESH_ENABLED_ENV = 'QUOTA_OFFICIAL_REFRESH_ENABLED';
const CLAUDE_CREDENTIALS_PATH_ENV = 'CLAUDE_CREDENTIALS_PATH';
const CODEX_CREDENTIALS_PATH_ENV = 'CODEX_CREDENTIALS_PATH';

function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function hasOfficialProbeFailure(): boolean {
  const messages = [codexCache.error, claudeCache.error].filter((message): message is string => Boolean(message));
  return messages.some((message) => {
    if (/temporarily disabled/i.test(message)) return false;
    return /official fetch failed|OAuth failed|credentials/i.test(message);
  });
}

export function listQuotaProbeDescriptors(env: NodeJS.ProcessEnv = process.env): QuotaProbeDescriptor[] {
  const officialRefreshEnabled = isTruthyFlag(env[OFFICIAL_REFRESH_ENABLED_ENV]);
  const officialStatus: QuotaProbeRuntimeStatus = !officialRefreshEnabled
    ? 'disabled'
    : hasOfficialProbeFailure()
      ? 'error'
      : 'ok';
  const claudeStatus: QuotaProbeRuntimeStatus = /ccusage failed/i.test(claudeCache.error ?? '') ? 'error' : 'ok';

  return [
    {
      id: 'claude-cli',
      sourceKind: 'cli',
      refreshMode: 'manual',
      enabled: true,
      status: claudeStatus,
      targets: ['claude'],
      actions: [
        {
          kind: 'refresh',
          method: 'POST',
          path: '/api/quota/refresh/claude',
          requiresInteractive: false,
        },
      ],
      reason:
        claudeStatus === 'error'
          ? (claudeCache.error ?? 'ccusage probe error')
          : 'Uses ccusage CLI output. No browser scraping.',
    },
    {
      id: 'official-browser',
      sourceKind: 'cli',
      refreshMode: 'manual',
      enabled: officialRefreshEnabled,
      status: officialStatus,
      targets: ['codex', 'claude', 'kimi'],
      actions: [
        {
          kind: 'refresh',
          method: 'POST',
          path: '/api/quota/refresh/official',
          requiresInteractive: false,
        },
      ],
      reason:
        officialStatus === 'disabled'
          ? 'Disabled by default for risk control. Set QUOTA_OFFICIAL_REFRESH_ENABLED=1 to enable.'
          : officialStatus === 'error'
            ? (codexCache.error ?? claudeCache.error ?? 'official OAuth probe error')
            : 'Enabled. Uses Claude/Codex OAuth APIs plus Kimi official billing API (ClaudeBar-compatible).',
    },
    {
      id: 'kimi-official-web',
      sourceKind: 'browser',
      refreshMode: 'manual',
      enabled: officialRefreshEnabled,
      status: !officialRefreshEnabled ? 'disabled' : kimiCache.error ? 'error' : kimiCache.status === 'ok' ? 'ok' : 'ok',
      targets: ['kimi'],
      actions: [
        {
          kind: 'refresh',
          method: 'POST',
          path: '/api/quota/refresh/kimi',
          requiresInteractive: false,
        },
      ],
      reason:
        !officialRefreshEnabled
          ? 'Disabled by default for risk control. Set QUOTA_OFFICIAL_REFRESH_ENABLED=1 to enable.'
          : kimiCache.error ??
            kimiCache.note ??
            'Enabled. Uses Kimi official billing API (ClaudeBar-compatible).',
    },
    {
      id: 'antigravity-placeholder',
      sourceKind: 'placeholder',
      refreshMode: 'manual',
      enabled: false,
      status: 'disabled',
      targets: ['antigravity'],
      actions: [],
      reason: 'Antigravity official probe not implemented yet.',
    },
  ];
}

const KIMI_AUTH_TOKEN_ENV = 'KIMI_AUTH_TOKEN';
const KIMI_BILLING_URL = 'https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages';

interface KimiUsageResponse {
  usages: Array<{
    scope: string;
    detail: {
      limit: string;
      used?: string | null;
      remaining?: string | null;
      resetTime?: string | null;
    };
    limits?: Array<{
      window?: {
        duration?: number | null;
        timeUnit?: string | null;
      } | null;
      detail: {
        limit: string;
        used?: string | null;
        remaining?: string | null;
        resetTime?: string | null;
      };
    }> | null;
  }>;
}

function resolveKimiAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[KIMI_AUTH_TOKEN_ENV]?.trim();
  if (raw) return raw;
  return null;
}

function decodeKimiTokenContext(token: string): { deviceId?: string; sessionId?: string; trafficId?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
    return {
      deviceId: typeof decoded.device_id === 'string' ? decoded.device_id : undefined,
      sessionId: typeof decoded.ssid === 'string' ? decoded.ssid : undefined,
      trafficId: typeof decoded.sub === 'string' ? decoded.sub : undefined,
    };
  } catch {
    return null;
  }
}

function parseKimiUsageValue(detail: { limit: string; used?: string | null; remaining?: string | null }): {
  limit: number;
  used: number;
  remaining: number | null;
} | null {
  const limit = Number.parseInt(detail.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remaining = detail.remaining != null ? Number.parseInt(detail.remaining, 10) : null;
  const used =
    detail.used != null
      ? Number.parseInt(detail.used, 10)
      : Number.isFinite(remaining as number)
        ? Math.max(0, limit - (remaining as number))
        : 0;
  return {
    limit,
    used: Number.isFinite(used) ? used : 0,
    remaining: Number.isFinite(remaining as number) ? (remaining as number) : null,
  };
}

export function parseKimiOfficialUsageResponse(json: KimiUsageResponse): CodexUsageItem[] {
  const codingUsage = Array.isArray(json.usages) ? json.usages.find((item) => item.scope === 'FEATURE_CODING') : null;
  if (!codingUsage) return [];
  const items: CodexUsageItem[] = [];
  const weekly = parseKimiUsageValue(codingUsage.detail);
  if (weekly) {
    items.push({
      label: '每周使用限额',
      usedPercent: normalizePercent(Math.round((weekly.used / weekly.limit) * 10000) / 100),
      percentKind: 'used',
      poolId: 'kimi-weekly',
      ...(codingUsage.detail.resetTime ? { resetsAt: codingUsage.detail.resetTime } : {}),
      resetsText: `${weekly.used}/${weekly.limit} requests`,
    });
  }
  const rateLimit = Array.isArray(codingUsage.limits)
    ? codingUsage.limits.find((item) => item?.window?.duration === 5 && /hour/i.test(item?.window?.timeUnit ?? ''))
    : null;
  const rate = rateLimit ? parseKimiUsageValue(rateLimit.detail) : null;
  if (rate) {
    items.push({
      label: '5小时使用限额',
      usedPercent: normalizePercent(Math.round((rate.used / rate.limit) * 10000) / 100),
      percentKind: 'used',
      poolId: 'kimi-rate-limit',
      ...(rateLimit?.detail.resetTime ? { resetsAt: rateLimit.detail.resetTime } : {}),
      resetsText: `${rate.used}/${rate.limit} requests / 5h`,
    });
  }
  return items;
}

function normalizePercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function toUtilizationPercent(item: CodexUsageItem): number {
  const raw = item.percentKind === 'remaining' ? 100 - item.usedPercent : item.usedPercent;
  return normalizePercent(raw);
}

function pickPrimaryUsageItem(items: CodexUsageItem[]): CodexUsageItem | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => {
    const utilizationDiff = toUtilizationPercent(right) - toUtilizationPercent(left);
    if (utilizationDiff !== 0) return utilizationDiff;
    const rank = (label: string): number => {
      if (/(weekly|每周)/i.test(label)) return 2;
      if (/(5\s*小时|5(?:\s|-)?hour)/i.test(label)) return 1;
      return 0;
    };
    return rank(right.label) - rank(left.label);
  });
  return sorted[0] ?? null;
}

function statusFromUtilization(utilization: number): QuotaSummaryPlatform['status'] {
  if (utilization >= 95) return 'error';
  if (utilization >= 80) return 'warn';
  return 'ok';
}

function buildCodexSummaryPlatform(): QuotaSummaryPlatform {
  if (codexCache.error) {
    return {
      id: 'codex',
      label: '缅因猫 (Codex + GPT-5.2)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'error',
      note: codexCache.error,
      lastChecked: codexCache.lastChecked,
    };
  }
  const primary = pickPrimaryUsageItem(codexCache.usageItems);
  if (!primary) {
    return {
      id: 'codex',
      label: '缅因猫 (Codex + GPT-5.2)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'pending',
      note: '暂无官方额度数据，请先手动获取。',
      lastChecked: codexCache.lastChecked,
    };
  }
  const utilization = toUtilizationPercent(primary);
  return {
    id: 'codex',
    label: '缅因猫 (Codex + GPT-5.2)',
    displayPercent: normalizePercent(primary.usedPercent),
    displayKind: primary.percentKind ?? 'used',
    utilizationPercent: utilization,
    status: statusFromUtilization(utilization),
    note: primary.resetsText ?? primary.resetsAt ?? primary.label,
    lastChecked: codexCache.lastChecked,
  };
}

function buildClaudeSummaryPlatform(): QuotaSummaryPlatform {
  if (claudeCache.error) {
    return {
      id: 'claude',
      label: '布偶猫 (Claude)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'error',
      note: claudeCache.error,
      lastChecked: claudeCache.lastChecked,
    };
  }
  const usageItems = claudeCache.usageItems ?? [];
  const primary = pickPrimaryUsageItem(usageItems);
  if (primary) {
    const utilization = toUtilizationPercent(primary);
    return {
      id: 'claude',
      label: '布偶猫 (Claude)',
      displayPercent: normalizePercent(primary.usedPercent),
      displayKind: primary.percentKind ?? 'used',
      utilizationPercent: utilization,
      status: statusFromUtilization(utilization),
      note: primary.resetsText ?? primary.resetsAt ?? primary.label,
      lastChecked: claudeCache.lastChecked,
    };
  }
  if (claudeCache.activeBlock) {
    return {
      id: 'claude',
      label: '布偶猫 (Claude)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'ok',
      note: 'CLI 活跃计费窗口已加载（无百分比摘要）。',
      lastChecked: claudeCache.lastChecked,
    };
  }
  return {
    id: 'claude',
    label: '布偶猫 (Claude)',
    displayPercent: null,
    displayKind: null,
    utilizationPercent: null,
    status: 'pending',
    note: '暂无 Claude 额度数据，请先手动获取。',
    lastChecked: claudeCache.lastChecked,
  };
}

function buildAntigravitySummaryPlatform(): QuotaSummaryPlatform {
  if (antigravityCache.error) {
    return {
      id: 'antigravity',
      label: '暹罗猫 (Antigravity)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'error',
      note: antigravityCache.error,
      lastChecked: antigravityCache.lastChecked,
    };
  }
  const primary = pickPrimaryUsageItem(antigravityCache.usageItems);
  if (!primary) {
    return {
      id: 'antigravity',
      label: '暹罗猫 (Antigravity)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'pending',
      note: '暹罗猫额度待获取。',
      lastChecked: antigravityCache.lastChecked,
    };
  }
  const utilization = toUtilizationPercent(primary);
  return {
    id: 'antigravity',
    label: '暹罗猫 (Antigravity)',
    displayPercent: normalizePercent(primary.usedPercent),
    displayKind: primary.percentKind ?? 'used',
    utilizationPercent: utilization,
    status: statusFromUtilization(utilization),
    note: primary.resetsText ?? primary.resetsAt ?? primary.label,
    lastChecked: antigravityCache.lastChecked,
  };
}

function buildKimiSummaryPlatform(): QuotaSummaryPlatform {
  const officialRefreshEnabled = isTruthyFlag(process.env[OFFICIAL_REFRESH_ENABLED_ENV]);
  if (kimiCache.error) {
    return {
      id: 'kimi',
      label: '金吉拉 (Kimi)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'error',
      note: kimiCache.error,
      lastChecked: kimiCache.lastChecked,
    };
  }
  if (kimiCache.status === 'unavailable') {
    return {
      id: 'kimi',
      label: '金吉拉 (Kimi)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'pending',
      note:
        kimiCache.note ??
        (officialRefreshEnabled
          ? `暂无 Kimi 官方额度数据，请配置 ${KIMI_AUTH_TOKEN_ENV} 后刷新。`
          : `官方额度抓取默认关闭，请先设 ${OFFICIAL_REFRESH_ENABLED_ENV}=1。`),
      lastChecked: kimiCache.lastChecked,
    };
  }
  const primary = pickPrimaryUsageItem(kimiCache.usageItems);
  if (!primary) {
    return {
      id: 'kimi',
      label: '金吉拉 (Kimi)',
      displayPercent: null,
      displayKind: null,
      utilizationPercent: null,
      status: 'pending',
      note: '暂无 Kimi 额度数据。',
      lastChecked: kimiCache.lastChecked,
    };
  }
  const utilization = toUtilizationPercent(primary);
  return {
    id: 'kimi',
    label: '金吉拉 (Kimi)',
    displayPercent: normalizePercent(primary.usedPercent),
    displayKind: primary.percentKind ?? 'used',
    utilizationPercent: utilization,
    status: statusFromUtilization(utilization),
    note: primary.resetsText ?? primary.resetsAt ?? primary.label,
    lastChecked: kimiCache.lastChecked,
  };
}

export function buildQuotaSummary(env: NodeJS.ProcessEnv = process.env): QuotaSummaryResponse {
  const probes = listQuotaProbeDescriptors(env);
  const officialProbe = probes.find((probe) => probe.id === 'official-browser');
  const claudeCliProbe = probes.find((probe) => probe.id === 'claude-cli');
  const codex = buildCodexSummaryPlatform();
  const claude = buildClaudeSummaryPlatform();
  const kimi = buildKimiSummaryPlatform();
  const antigravity = buildAntigravitySummaryPlatform();

  const utilizationValues = [codex.utilizationPercent, claude.utilizationPercent, kimi.utilizationPercent, antigravity.utilizationPercent].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  const maxUtilization = utilizationValues.length > 0 ? Math.max(...utilizationValues) : null;

  const reasons: string[] = [];
  let level: QuotaRiskLevel = 'ok';

  if (officialProbe?.status === 'disabled') {
    reasons.push('官方额度探针已禁用（止血模式）');
    level = 'warn';
  }

  if (officialProbe?.status === 'error') {
    reasons.push('官方额度探针运行异常，请检查 OAuth 凭据配置');
    level = 'high';
  }

  if (codex.status === 'error') {
    reasons.push(`缅因猫额度异常：${codex.note}`);
    level = 'high';
  }

  if (claude.status === 'error') {
    reasons.push(`布偶猫额度异常：${claude.note}`);
    level = 'high';
  }

  if (maxUtilization != null && maxUtilization >= 95) {
    reasons.push(`综合利用率达到 ${maxUtilization}%（高风险）`);
    level = 'high';
  } else if (maxUtilization != null && maxUtilization >= 80) {
    reasons.push(`综合利用率达到 ${maxUtilization}%（需关注）`);
    if (level !== 'high') level = 'warn';
  }

  return {
    fetchedAt: new Date().toISOString(),
    risk: {
      level,
      reasons,
      maxUtilization,
    },
    platforms: {
      codex,
      claude,
      kimi,
      antigravity,
    },
    probes: {
      official: {
        enabled: officialProbe?.enabled ?? false,
        status: officialProbe?.status ?? 'disabled',
        reason: officialProbe?.reason ?? 'official-browser probe unavailable',
      },
      claudeCli: {
        enabled: claudeCliProbe?.enabled ?? true,
        status: claudeCliProbe?.status ?? 'ok',
        reason: claudeCliProbe?.reason ?? 'claude-cli probe unavailable',
      },
      kimiOfficial: {
        enabled: probes.some((probe) => probe.id === 'kimi-official-web' && probe.enabled),
        status:
          probes.find((probe) => probe.id === 'kimi-official-web')?.status ??
          (kimiCache.error ? 'error' : kimiCache.status === 'ok' ? 'ok' : 'disabled'),
        reason:
          probes.find((probe) => probe.id === 'kimi-official-web')?.reason ??
          kimiCache.error ??
          kimiCache.note ??
          'Kimi official probe unavailable',
      },
    },
    actions: {
      refreshOfficialPath: '/api/quota/refresh/official',
      refreshClaudePath: '/api/quota/refresh/claude',
      refreshKimiPath: '/api/quota/refresh/kimi',
    },
  };
}

// ============================================================
// v3 OAuth API parsers (replaces browser page text parsing)
// ============================================================

interface ClaudeOAuthQuotaBucket {
  used_percent?: number;
  reset_at?: string;
}

interface ClaudeOAuthUsageResponse {
  five_hour?: ClaudeOAuthQuotaBucket;
  seven_day?: ClaudeOAuthQuotaBucket;
  seven_day_sonnet?: ClaudeOAuthQuotaBucket;
  seven_day_opus?: ClaudeOAuthQuotaBucket;
  extra_usage?: { used_cents?: number; limit_cents?: number };
}

export function parseClaudeOAuthUsageResponse(json: ClaudeOAuthUsageResponse): CodexUsageItem[] {
  const defs: Array<{ key: keyof ClaudeOAuthUsageResponse; label: string; poolId: string }> = [
    { key: 'five_hour', label: 'Session 5h', poolId: 'claude-session' },
    { key: 'seven_day', label: 'Weekly all models', poolId: 'claude-weekly-all' },
    { key: 'seven_day_sonnet', label: 'Weekly Sonnet', poolId: 'claude-weekly-sonnet' },
    { key: 'seven_day_opus', label: 'Weekly Opus', poolId: 'claude-weekly-opus' },
  ];
  const items: CodexUsageItem[] = [];
  for (const def of defs) {
    const bucket = json[def.key];
    if (!bucket || typeof bucket !== 'object' || !('used_percent' in bucket)) continue;
    const pct = (bucket as ClaudeOAuthQuotaBucket).used_percent;
    if (pct == null || typeof pct !== 'number') continue;
    items.push({
      label: def.label,
      usedPercent: Math.max(0, Math.min(100, pct)),
      percentKind: 'used',
      poolId: def.poolId,
      ...((bucket as ClaudeOAuthQuotaBucket).reset_at ? { resetsAt: (bucket as ClaudeOAuthQuotaBucket).reset_at } : {}),
    });
  }
  return items;
}

interface CodexWhamRateLimitWindow {
  used_percent?: number;
  reset_at?: string;
  label?: string;
}

interface CodexWhamUsageResponse {
  rate_limit?: {
    primary_window?: CodexWhamRateLimitWindow;
    secondary_window?: CodexWhamRateLimitWindow;
    spark_primary?: CodexWhamRateLimitWindow;
    spark_secondary?: CodexWhamRateLimitWindow;
    code_review?: CodexWhamRateLimitWindow;
  };
  credits_balance?: number;
}

export function parseCodexWhamUsageResponse(json: CodexWhamUsageResponse): CodexUsageItem[] {
  const items: CodexUsageItem[] = [];
  const rl = json.rate_limit;
  if (!rl) return items;

  const defs: Array<{ key: keyof NonNullable<typeof rl>; label: string; poolId: string }> = [
    { key: 'primary_window', label: '5小时使用限额', poolId: 'codex-main' },
    { key: 'secondary_window', label: '每周使用限额', poolId: 'codex-main' },
    { key: 'spark_primary', label: 'GPT-5.3-Codex-Spark 5小时使用限额', poolId: 'codex-spark' },
    { key: 'spark_secondary', label: 'GPT-5.3-Codex-Spark 每周使用限额', poolId: 'codex-spark' },
    { key: 'code_review', label: '代码审查', poolId: 'codex-review' },
  ];

  for (const def of defs) {
    const window = rl[def.key];
    if (!window || typeof window !== 'object') continue;
    const pct = window.used_percent;
    if (pct == null || typeof pct !== 'number') continue;
    items.push({
      label: window.label ?? def.label,
      usedPercent: Math.max(0, Math.min(100, pct)),
      percentKind: 'used',
      poolId: def.poolId,
      ...(window.reset_at ? { resetsAt: window.reset_at } : {}),
    });
  }

  // Overflow credits
  if ('credits_balance' in json && typeof json.credits_balance === 'number') {
    items.push({
      label: '溢出额度',
      usedPercent: Math.max(0, Math.min(100, json.credits_balance)),
      percentKind: 'remaining',
      poolId: 'codex-overflow',
    });
  }

  return items;
}

// ============================================================
// v3 OAuth refresh orchestrator
// ============================================================

function loadClaudeCredentials(envPath?: string): OAuthCredentials | null {
  const credPath = envPath || join(homedir(), '.claude', '.credentials.json');
  try {
    const raw = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.claudeAiOauth?.accessToken && parsed.claudeAiOauth?.refreshToken) {
      return {
        accessToken: parsed.claudeAiOauth.accessToken,
        refreshToken: parsed.claudeAiOauth.refreshToken,
      };
    }
    // Fallback: flat structure
    if (parsed.accessToken && parsed.refreshToken) {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
    return null;
  } catch {
    return null;
  }
}

function loadCodexCredentials(envPath?: string): CodexOAuthCredentials | null {
  if (!envPath) return null;
  try {
    const raw = readFileSync(envPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accountId: parsed.accountId,
    };
  } catch {
    return null;
  }
}

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OPENAI_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_TOKEN_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
}

interface CodexOAuthCredentials extends OAuthCredentials {
  accountId?: string;
}

interface RefreshOAuthOptions {
  claudeCredentials: OAuthCredentials | null;
  codexCredentials: CodexOAuthCredentials | null;
  kimiAuthToken?: string | null;
  fetchLike?: typeof globalThis.fetch;
}

interface RefreshOAuthProviderResult {
  items: number;
  error?: string;
}

interface RefreshOAuthResult {
  claude?: RefreshOAuthProviderResult;
  codex?: RefreshOAuthProviderResult;
  kimi?: RefreshOAuthProviderResult;
  skipped?: string[];
}

async function refreshAccessToken(
  refreshUrl: string,
  clientId: string,
  refreshToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const response = await fetchFn(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

class TokenExpiredError extends Error {
  constructor(status: number) {
    super(`API returned ${status}`);
    this.name = 'TokenExpiredError';
  }
}

async function fetchProviderUsage(
  url: string,
  accessToken: string,
  extraHeaders: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
): Promise<{ json: unknown; status: number }> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...extraHeaders,
    },
  });
  if (response.status === 401) {
    throw new TokenExpiredError(401);
  }
  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }
  const json = await response.json();
  return { json, status: response.status };
}

export async function refreshOfficialQuotaViaOAuth(options: RefreshOAuthOptions): Promise<RefreshOAuthResult> {
  const fetchFn = options.fetchLike ?? globalThis.fetch.bind(globalThis);
  const result: RefreshOAuthResult = {};
  const skipped: string[] = [];

  const tasks: Array<Promise<void>> = [];

  if (options.claudeCredentials) {
    tasks.push(
      (async () => {
        const creds = options.claudeCredentials!;
        let token = creds.accessToken;
        try {
          let json: unknown;
          try {
            ({ json } = await fetchProviderUsage(ANTHROPIC_USAGE_URL, token, {}, fetchFn));
          } catch (err) {
            if (err instanceof TokenExpiredError) {
              const freshToken = await refreshAccessToken(
                ANTHROPIC_TOKEN_REFRESH_URL,
                ANTHROPIC_CLIENT_ID,
                creds.refreshToken,
                fetchFn,
              );
              if (freshToken) {
                token = freshToken;
                ({ json } = await fetchProviderUsage(ANTHROPIC_USAGE_URL, token, {}, fetchFn));
              } else {
                throw new Error('API returned 401; token refresh failed');
              }
            } else {
              throw err;
            }
          }
          const items = parseClaudeOAuthUsageResponse(json as Parameters<typeof parseClaudeOAuthUsageResponse>[0]);
          const { error: _oldError, ...claudeWithoutError } = claudeCache;
          claudeCache = {
            ...claudeWithoutError,
            usageItems: items,
            lastChecked: new Date().toISOString(),
          };
          result.claude = { items: items.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          claudeCache = {
            ...claudeCache,
            error: `Claude OAuth failed: ${message}`,
            lastChecked: new Date().toISOString(),
          };
          result.claude = { items: 0, error: `Claude OAuth failed: ${message}` };
        }
      })(),
    );
  } else {
    skipped.push('claude');
  }

  if (options.codexCredentials) {
    tasks.push(
      (async () => {
        const creds = options.codexCredentials!;
        let token = creds.accessToken;
        const extraHeaders: Record<string, string> = {};
        if (creds.accountId) {
          extraHeaders['ChatGPT-Account-Id'] = creds.accountId;
        }
        try {
          let json: unknown;
          try {
            ({ json } = await fetchProviderUsage(OPENAI_WHAM_USAGE_URL, token, extraHeaders, fetchFn));
          } catch (err) {
            if (err instanceof TokenExpiredError) {
              const freshToken = await refreshAccessToken(
                OPENAI_TOKEN_REFRESH_URL,
                OPENAI_CLIENT_ID,
                creds.refreshToken,
                fetchFn,
              );
              if (freshToken) {
                token = freshToken;
                ({ json } = await fetchProviderUsage(OPENAI_WHAM_USAGE_URL, token, extraHeaders, fetchFn));
              } else {
                throw new Error('API returned 401; token refresh failed');
              }
            } else {
              throw err;
            }
          }
          const items = parseCodexWhamUsageResponse(json as Parameters<typeof parseCodexWhamUsageResponse>[0]);
          codexCache = {
            platform: 'codex',
            usageItems: items,
            lastChecked: new Date().toISOString(),
          };
          result.codex = { items: items.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          codexCache = {
            ...codexCache,
            error: `Codex OAuth failed: ${message}`,
            lastChecked: new Date().toISOString(),
          };
          result.codex = { items: 0, error: `Codex OAuth failed: ${message}` };
        }
      })(),
    );
  } else {
    skipped.push('codex');
  }

  if (options.kimiAuthToken) {
    tasks.push(
      (async () => {
        const token = options.kimiAuthToken!;
        const tokenContext = decodeKimiTokenContext(token);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: `kimi-auth=${token}`,
          Origin: 'https://www.kimi.com',
          Referer: 'https://www.kimi.com/code/console',
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          'connect-protocol-version': '1',
          'x-language': 'en-US',
          'x-msh-platform': 'web',
        };
        if (tokenContext?.deviceId) headers['x-msh-device-id'] = tokenContext.deviceId;
        if (tokenContext?.sessionId) headers['x-msh-session-id'] = tokenContext.sessionId;
        if (tokenContext?.trafficId) headers['x-traffic-id'] = tokenContext.trafficId;
        try {
          const response = await fetchFn(KIMI_BILLING_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ scope: ['FEATURE_CODING'] }),
          });
          if (response.status === 401 || response.status === 403) {
            throw new Error(`Kimi auth failed: HTTP ${response.status}`);
          }
          if (!response.ok) {
            throw new Error(`Kimi billing API failed: HTTP ${response.status}`);
          }
          const json = (await response.json()) as KimiUsageResponse;
          const items = parseKimiOfficialUsageResponse(json);
          if (items.length === 0) {
            throw new Error('Kimi billing API returned no FEATURE_CODING usage windows');
          }
          kimiCache = {
            platform: 'kimi',
            usageItems: items,
            lastChecked: new Date().toISOString(),
            status: 'ok',
            note: '来自 Kimi 官方额度接口（每周 + 5 小时窗口）。',
          };
          result.kimi = { items: items.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          kimiCache = {
            platform: 'kimi',
            usageItems: [],
            error: message,
            lastChecked: new Date().toISOString(),
            status: 'unavailable',
            note: message,
          };
          result.kimi = { items: 0, error: message };
        }
      })(),
    );
  } else {
    skipped.push('kimi');
  }

  await Promise.all(tasks);
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}

// --- Route ---

export async function quotaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/quota/probes', async () => {
    return {
      probes: listQuotaProbeDescriptors(),
      fetchedAt: new Date().toISOString(),
    };
  });

  // GET: return all cached quota
  app.get('/api/quota', async () => {
    const response: QuotaResponse = {
      claude: claudeCache,
      codex: codexCache,
      gemini: geminiCache,
      kimi: kimiCache,
      antigravity: antigravityCache,
      fetchedAt: new Date().toISOString(),
    };
    return response;
  });

  // GET: compact summary for menu bar / widget clients
  app.get('/api/quota/summary', async () => {
    return buildQuotaSummary();
  });

  // POST: refresh Kimi quota from official billing API
  app.post('/api/quota/refresh/kimi', async (_request, reply) => {
    if (!isTruthyFlag(process.env[OFFICIAL_REFRESH_ENABLED_ENV])) {
      const message = `Official quota refresh is temporarily disabled. Set ${OFFICIAL_REFRESH_ENABLED_ENV}=1 to enable it.`;
      kimiCache = {
        ...kimiCache,
        error: message,
        status: 'unavailable',
        note: message,
        lastChecked: new Date().toISOString(),
      };
      return reply.status(503).send({ error: message });
    }
    const kimiAuthToken = resolveKimiAuthToken(process.env);
    if (!kimiAuthToken) {
      const message = `No Kimi official auth token found. Set ${KIMI_AUTH_TOKEN_ENV}.`;
      kimiCache = {
        ...kimiCache,
        error: message,
        status: 'unavailable',
        note: message,
        lastChecked: new Date().toISOString(),
      };
      return reply.status(400).send({ error: message });
    }
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: null,
      kimiAuthToken,
    });
    if ((result.kimi?.items ?? 0) === 0 && result.kimi?.error) {
      return reply.status(502).send({ error: result.kimi.error });
    }
    return { kimi: kimiCache };
  });

  // POST: refresh Claude quota via ccusage CLI
  app.post('/api/quota/refresh/claude', async () => {
    try {
      const { stdout } = await execFileAsync('npx', ['ccusage', 'blocks', '--json'], { timeout: 30_000 });
      const parsed = JSON.parse(stdout) as { blocks: CcusageBillingBlock[] };
      const blocks = parsed.blocks.filter((b) => !b.isGap);
      const activeBlock = blocks.find((b) => b.isActive) ?? null;
      claudeCache = {
        platform: 'claude',
        activeBlock,
        recentBlocks: blocks.slice(-5),
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      claudeCache = {
        ...claudeCache,
        error: `ccusage failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { claude: claudeCache };
  });

  // POST: refresh official quota via OAuth APIs (v3, ClaudeBar-compatible)
  app.post('/api/quota/refresh/official', async (_request, reply) => {
    if (!isTruthyFlag(process.env[OFFICIAL_REFRESH_ENABLED_ENV])) {
      const message = `Official quota refresh is temporarily disabled. Set ${OFFICIAL_REFRESH_ENABLED_ENV}=1 to enable it.`;
      const checkedAt = new Date().toISOString();
      codexCache = {
        ...codexCache,
        error: message,
        lastChecked: checkedAt,
      };
      claudeCache = {
        ...claudeCache,
        error: message,
        lastChecked: checkedAt,
      };
      return reply.status(503).send({ error: message });
    }

    // Load credentials from files
    const claudeCredentials = loadClaudeCredentials(process.env[CLAUDE_CREDENTIALS_PATH_ENV]);
    const codexCredentials = loadCodexCredentials(process.env[CODEX_CREDENTIALS_PATH_ENV]);
    const kimiAuthToken = resolveKimiAuthToken(process.env);

    if (!claudeCredentials && !codexCredentials && !kimiAuthToken) {
      const message =
        `No official quota credentials found. Claude: ~/.claude/.credentials.json, Codex: set ${CODEX_CREDENTIALS_PATH_ENV}, Kimi: set ${KIMI_AUTH_TOKEN_ENV}.`;
      const checkedAt = new Date().toISOString();
      codexCache = { ...codexCache, error: message, lastChecked: checkedAt };
      claudeCache = { ...claudeCache, error: message, lastChecked: checkedAt };
      kimiCache = { ...kimiCache, error: message, status: 'unavailable', note: message, lastChecked: checkedAt };
      return reply.status(400).send({ error: message });
    }

    const result = await refreshOfficialQuotaViaOAuth({ claudeCredentials, codexCredentials, kimiAuthToken });
    const errors = [result.claude?.error, result.codex?.error, result.kimi?.error].filter(Boolean);
    if (errors.length > 0 && (result.claude?.items ?? 0) === 0 && (result.codex?.items ?? 0) === 0 && (result.kimi?.items ?? 0) === 0) {
      return reply.status(502).send({ error: errors.join('; ') });
    }
    return {
      ok: true,
      claudeItems: result.claude?.items ?? 0,
      codexItems: result.codex?.items ?? 0,
      kimiItems: result.kimi?.items ?? 0,
      ...(errors.length > 0 ? { warnings: errors } : {}),
      ...(result.skipped && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
    };
  });

  // PATCH: receive Codex usage data OR scrape failure
  const codexSuccessSchema = z.object({
    usageItems: z
      .array(
        z.object({
          label: z.string().min(1),
          usedPercent: z.number().min(0).max(100),
          percentKind: z.enum(['used', 'remaining']).optional(),
          poolId: z.string().optional(),
          resetsAt: z.string().optional(),
        }),
      )
      .min(1),
    pageText: z.string().optional(),
  });
  const codexErrorSchema = z.object({
    error: z.string().min(1),
  });
  const codexPatchSchema = z.union([codexSuccessSchema, codexErrorSchema]);

  app.patch('/api/quota/codex', async (request, reply) => {
    const parsed = codexPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid codex usage payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if ('error' in parsed.data) {
      codexCache = {
        platform: 'codex',
        usageItems: [],
        error: parsed.data.error,
        lastChecked: new Date().toISOString(),
      };
    } else {
      codexCache = {
        platform: 'codex',
        usageItems: parsed.data.usageItems.map((item) => ({
          label: item.label,
          usedPercent: item.usedPercent,
          ...(item.percentKind != null && { percentKind: item.percentKind }),
          ...(item.poolId != null && { poolId: item.poolId }),
          ...(item.resetsAt != null && { resetsAt: item.resetsAt }),
        })),
        lastChecked: new Date().toISOString(),
      };
    }
    return { codex: codexCache };
  });

  // PATCH: receive Gemini usage data OR error
  const geminiPatchSchema = z.union([codexSuccessSchema, codexErrorSchema]);

  app.patch('/api/quota/gemini', async (request, reply) => {
    const parsed = geminiPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid gemini usage payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if ('error' in parsed.data) {
      geminiCache = {
        platform: 'gemini',
        usageItems: [],
        error: parsed.data.error,
        lastChecked: new Date().toISOString(),
      };
    } else {
      geminiCache = {
        platform: 'gemini',
        usageItems: parsed.data.usageItems.map((item) => ({
          label: item.label,
          usedPercent: item.usedPercent,
          ...(item.percentKind != null && { percentKind: item.percentKind }),
          ...(item.poolId != null && { poolId: item.poolId }),
          ...(item.resetsAt != null && { resetsAt: item.resetsAt }),
        })),
        lastChecked: new Date().toISOString(),
      };
    }
    return { gemini: geminiCache };
  });

  // PATCH: receive Antigravity usage data OR error
  const antigravityPatchSchema = z.union([codexSuccessSchema, codexErrorSchema]);

  app.patch('/api/quota/antigravity', async (request, reply) => {
    const parsed = antigravityPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid antigravity usage payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if ('error' in parsed.data) {
      antigravityCache = {
        platform: 'antigravity',
        usageItems: [],
        error: parsed.data.error,
        lastChecked: new Date().toISOString(),
      };
    } else {
      antigravityCache = {
        platform: 'antigravity',
        usageItems: parsed.data.usageItems.map((item) => ({
          label: item.label,
          usedPercent: item.usedPercent,
          ...(item.percentKind != null && { percentKind: item.percentKind }),
          ...(item.poolId != null && { poolId: item.poolId }),
          ...(item.resetsAt != null && { resetsAt: item.resetsAt }),
        })),
        lastChecked: new Date().toISOString(),
      };
    }
    return { antigravity: antigravityCache };
  });
}
