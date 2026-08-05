import { createHash } from 'node:crypto';
import { isCompletePawFeelDutyConfig, type PawFeelDispositionState, type PawFeelDutyConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const DUTY_NOTICE_KEY = 'paw-feel:disposition:duty-notice';
const SYSTEM_THREAD_ID = 'thread_eval_friction' as const;
const OVERDUE_AFTER_MS = 24 * 3_600_000;
const CVO_BREACH_AFTER_MS = 72 * 3_600_000;

export interface PawFeelDutySignalSummary {
  signalId: string;
  bundleKey: string;
  sourceMessageId: string;
  state: Extract<PawFeelDispositionState, 'new' | 'seen' | 'route_pending'>;
  sequence: number;
  discoveredAt: string;
  lastTransitionAt: string;
}

export type PawFeelDutySlaTier = 'normal' | 'overdue' | 'cvo_breach';

export interface PawFeelDutyNotice {
  systemThreadId: typeof SYSTEM_THREAD_ID;
  targetCatId?: string;
  slaTier: PawFeelDutySlaTier;
  rawSignalCount: number;
  reviewBundleCount: number;
  /** Compatibility alias for rawSignalCount. */
  count: number;
  oldestAgeMs: number;
  watermark: string;
  content: string;
}

export type PawFeelDutyNoticeClaim =
  | { outcome: 'claimed' }
  | { outcome: 'resume_invocation'; messageId: string }
  | { outcome: 'claimed_elsewhere' }
  | { outcome: 'complete' };

export interface IPawFeelDutyNoticeWatermarkStore {
  claim(watermark: string, claimedAt: string): Promise<PawFeelDutyNoticeClaim>;
  markDelivered(watermark: string, messageId: string, updatedAt: string): Promise<void>;
  markComplete(watermark: string, updatedAt: string): Promise<void>;
}

const CLAIM_LUA = `
local current = redis.call('HGET', KEYS[1], 'watermark')
if current ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'watermark', ARGV[1], 'status', 'claimed', 'updatedAt', ARGV[2])
  return {1, ''}
end

local status = redis.call('HGET', KEYS[1], 'status')
if status == 'delivered' then return {2, redis.call('HGET', KEYS[1], 'messageId') or ''} end
if status == 'complete' then return {3, ''} end
return {4, ''}
`;

const DELIVERED_LUA = `
if redis.call('HGET', KEYS[1], 'watermark') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'delivered', 'messageId', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

const COMPLETE_LUA = `
if redis.call('HGET', KEYS[1], 'watermark') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'complete', 'updatedAt', ARGV[2])
return 1
`;

function ageMs(discoveredAt: string, nowMs: number): number {
  const parsed = Date.parse(discoveredAt);
  if (!Number.isFinite(parsed)) throw new Error(`invalid discoveredAt: ${discoveredAt}`);
  return Math.max(0, nowMs - parsed);
}

function selectSlaTier(oldestAgeMs: number): PawFeelDutySlaTier {
  if (oldestAgeMs >= CVO_BREACH_AFTER_MS) return 'cvo_breach';
  if (oldestAgeMs >= OVERDUE_AFTER_MS) return 'overdue';
  return 'normal';
}

function watermarkFor(
  items: readonly PawFeelDutySignalSummary[],
  duty: PawFeelDutyConfig | null,
  slaTier: PawFeelDutySlaTier,
): string {
  const material = {
    dutyVersion: duty?.version ?? 0,
    slaTier,
    signals: [...items]
      .sort((left, right) => left.signalId.localeCompare(right.signalId))
      .map((item) => [item.signalId, item.sequence, item.state]),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function buildPawFeelDutyNotice(
  items: readonly PawFeelDutySignalSummary[],
  duty: PawFeelDutyConfig | null,
  nowMs: number,
  inboxHref: string,
): PawFeelDutyNotice {
  if (items.length === 0) throw new Error('cannot build a duty notice for an empty inbox');
  const oldestAgeMs = Math.max(...items.map((item) => ageMs(item.discoveredAt, nowMs)));
  const slaTier = selectSlaTier(oldestAgeMs);
  const completeDuty = isCompletePawFeelDutyConfig(duty);
  const targetCatId = completeDuty ? duty.primaryCatId : undefined;
  const hours = Math.floor(oldestAgeMs / 3_600_000);
  const reviewBundleCount = new Set(items.map((item) => item.bundleKey)).size;
  const representativeSources = [
    ...new Map(
      [...items]
        .sort((left, right) => left.bundleKey.localeCompare(right.bundleKey))
        .map((item) => [item.bundleKey, item.sourceMessageId]),
    ).values(),
  ].slice(0, 5);
  const status = !completeDuty
    ? '值班配置不完整，不能进入运营闭环'
    : slaTier === 'cvo_breach'
      ? '已超过 72h，Primary 继续负责；Workspace 向 operator 标红'
      : slaTier === 'overdue'
        ? '已超过 24h，Primary 继续负责'
        : '等待值班猫审阅';
  const dutyLine = targetCatId
    ? `本批责任猫：@${targetCatId}`
    : duty
      ? '值班配置不完整；必须同时配置不同的 primary / backup，系统不猜 owner。'
      : '尚未配置值班猫；系统线程继续持有可见责任，不自动猜 owner。';
  const content = [
    '## F278 爪感差责任收件箱',
    '',
    `待审 ${reviewBundleCount} 个 bundle / ${items.length} 条 raw signal；最久 ${hours}h；${status}。`,
    dutyLine,
    `工作台：${inboxHref}`,
    '处理契约：分页或 10/20/50 条上限只限制单次工具调用或上下文切片，不是任务终点；当班猫必须沿同一责任链持续续跑，直到 active=0，或每个剩余 actionable bundle 均绑定真实 task + named owner + active F167 lease，或已有等待 operator 审批的 durable proposal。仅有 owner、task、transport receipt 或 chat prose 都不是终点；预算将尽时必须建立结构化续跑，不得静默等下一轮 cron。',
    '',
    '代表原消息（每 bundle 至多一个；本通知不复制 marker 正文）：',
    ...representativeSources.map((sourceMessageId) => `- ${sourceMessageId}`),
  ].join('\n');
  return {
    systemThreadId: SYSTEM_THREAD_ID,
    ...(targetCatId ? { targetCatId } : {}),
    slaTier,
    rawSignalCount: items.length,
    reviewBundleCount,
    count: items.length,
    oldestAgeMs,
    watermark: watermarkFor(items, duty, slaTier),
    content,
  };
}

export class RedisPawFeelDutyNoticeWatermarkStore implements IPawFeelDutyNoticeWatermarkStore {
  constructor(private readonly redis: RedisClient) {}

  async claim(watermark: string, claimedAt: string): Promise<PawFeelDutyNoticeClaim> {
    const result = (await this.redis.eval(CLAIM_LUA, 1, DUTY_NOTICE_KEY, watermark, claimedAt)) as [number, string];
    if (result[0] === 1) return { outcome: 'claimed' };
    if (result[0] === 2) return { outcome: 'resume_invocation', messageId: result[1] };
    if (result[0] === 3) return { outcome: 'complete' };
    return { outcome: 'claimed_elsewhere' };
  }

  async markDelivered(watermark: string, messageId: string, updatedAt: string): Promise<void> {
    const updated = await this.redis.eval(DELIVERED_LUA, 1, DUTY_NOTICE_KEY, watermark, messageId, updatedAt);
    if (updated !== 1) throw new Error('duty notice watermark changed before delivery receipt');
  }

  async markComplete(watermark: string, updatedAt: string): Promise<void> {
    const updated = await this.redis.eval(COMPLETE_LUA, 1, DUTY_NOTICE_KEY, watermark, updatedAt);
    if (updated !== 1) throw new Error('duty notice watermark changed before completion');
  }
}

export const PawFeelDutyNoticeKey = DUTY_NOTICE_KEY;
