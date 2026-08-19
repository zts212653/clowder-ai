import { createHash } from 'node:crypto';
import {
  isCompletePawFeelDutyConfig,
  type PawFeelDispositionState,
  type PawFeelDutyConfig,
  type PawFeelResponsibilityProjection,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const DUTY_NOTICE_KEY = 'paw-feel:disposition:duty-notice';
const SYSTEM_THREAD_ID = 'thread_eval_friction' as const;
const OVERDUE_AFTER_MS = 24 * 3_600_000;
const CVO_BREACH_AFTER_MS = 72 * 3_600_000;

export interface PawFeelDutySignalSummary {
  signalId: string;
  bundleKey: string;
  sourceMessageId: string;
  state: PawFeelDispositionState;
  sequence: number;
  discoveredAt: string;
  lastTransitionAt: string;
  responsibility: PawFeelResponsibilityProjection;
}

export interface PawFeelDutyBatchSnapshot {
  bundles: Array<{
    bundleKey: string;
    members: Array<{ signalId: string; expectedSequence: number }>;
  }>;
}

export interface PawFeelDutyBatchRecord {
  watermark: string;
  status: 'claimed' | 'delivered' | 'awaiting_receipt' | 'complete';
  updatedAt: string;
  messageId?: string;
  snapshot: PawFeelDutyBatchSnapshot;
}

const DUTY_BATCH_STATUSES = new Set<PawFeelDutyBatchRecord['status']>([
  'claimed',
  'delivered',
  'awaiting_receipt',
  'complete',
]);

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
  | { outcome: 'resume_invocation'; watermark: string; messageId: string }
  | { outcome: 'claimed_elsewhere' }
  | { outcome: 'complete' };

export interface IPawFeelDutyNoticeWatermarkStore {
  claim(watermark: string, claimedAt: string, snapshot: PawFeelDutyBatchSnapshot): Promise<PawFeelDutyNoticeClaim>;
  readCurrent(): Promise<PawFeelDutyBatchRecord | null>;
  markDelivered(watermark: string, messageId: string, updatedAt: string): Promise<void>;
  markAwaitingReceipt(watermark: string, updatedAt: string): Promise<void>;
  markComplete(watermark: string, updatedAt: string): Promise<void>;
}

const CLAIM_LUA = `
local current = redis.call('HGET', KEYS[1], 'watermark')
if current and not redis.call('HGET', KEYS[1], 'snapshot') then
  redis.call('DEL', KEYS[1])
  current = false
end
if current ~= ARGV[1] then
  if current then
    local currentStatus = redis.call('HGET', KEYS[1], 'status')
    if currentStatus == 'delivered' then return {2, current, redis.call('HGET', KEYS[1], 'messageId') or ''} end
    if currentStatus == 'awaiting_receipt' then return {2, current, redis.call('HGET', KEYS[1], 'messageId') or ''} end
    if currentStatus ~= 'complete' then return {4, current, ''} end
  end
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'watermark', ARGV[1], 'status', 'claimed', 'updatedAt', ARGV[2], 'snapshot', ARGV[3])
  return {1, ARGV[1], ''}
end

local status = redis.call('HGET', KEYS[1], 'status')
if status == 'delivered' then return {2, current, redis.call('HGET', KEYS[1], 'messageId') or ''} end
if status == 'complete' then return {3, current, ''} end
if status == 'awaiting_receipt' then return {2, current, redis.call('HGET', KEYS[1], 'messageId') or ''} end
return {4, current, ''}
`;

const DELIVERED_LUA = `
if redis.call('HGET', KEYS[1], 'watermark') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'claimed' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'delivered', 'messageId', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

const COMPLETE_LUA = `
if redis.call('HGET', KEYS[1], 'watermark') ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'complete' then return 1 end
if status ~= 'awaiting_receipt' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'complete', 'updatedAt', ARGV[2])
return 1
`;

const AWAITING_RECEIPT_LUA = `
if redis.call('HGET', KEYS[1], 'watermark') ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'delivered' and status ~= 'awaiting_receipt' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'awaiting_receipt', 'updatedAt', ARGV[2])
return 1
`;

function ageMs(discoveredAt: string, nowMs: number): number {
  const parsed = Date.parse(discoveredAt);
  if (!Number.isFinite(parsed)) throw new Error(`invalid discoveredAt: ${discoveredAt}`);
  return Math.max(0, nowMs - parsed);
}

function parseDutyBatchSnapshot(rawSnapshot: string): PawFeelDutyBatchSnapshot {
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawSnapshot);
  } catch {
    throw new Error('invalid paw-feel duty batch snapshot');
  }
  if (!candidate || typeof candidate !== 'object' || !('bundles' in candidate)) {
    throw new Error('invalid paw-feel duty batch snapshot');
  }
  const bundles = (candidate as { bundles?: unknown }).bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('invalid paw-feel duty batch snapshot');
  }
  const bundleKeys = new Set<string>();
  const signalIds = new Set<string>();
  for (const bundle of bundles) {
    if (!bundle || typeof bundle !== 'object') throw new Error('invalid paw-feel duty batch snapshot');
    const { bundleKey, members } = bundle as { bundleKey?: unknown; members?: unknown };
    if (typeof bundleKey !== 'string' || bundleKey.length === 0 || bundleKeys.has(bundleKey)) {
      throw new Error('invalid paw-feel duty batch snapshot');
    }
    bundleKeys.add(bundleKey);
    if (!Array.isArray(members) || members.length === 0) throw new Error('invalid paw-feel duty batch snapshot');
    for (const member of members) {
      if (!member || typeof member !== 'object') throw new Error('invalid paw-feel duty batch snapshot');
      const { signalId, expectedSequence } = member as { signalId?: unknown; expectedSequence?: unknown };
      if (
        typeof signalId !== 'string' ||
        signalId.length === 0 ||
        signalIds.has(signalId) ||
        !Number.isInteger(expectedSequence) ||
        Number(expectedSequence) < 1
      ) {
        throw new Error('invalid paw-feel duty batch snapshot');
      }
      signalIds.add(signalId);
    }
  }
  return candidate as PawFeelDutyBatchSnapshot;
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

export function buildPawFeelDutyBatchSnapshot(items: readonly PawFeelDutySignalSummary[]): PawFeelDutyBatchSnapshot {
  const grouped = new Map<string, Array<{ signalId: string; expectedSequence: number }>>();
  for (const item of items) {
    const members = grouped.get(item.bundleKey) ?? [];
    members.push({ signalId: item.signalId, expectedSequence: item.sequence });
    grouped.set(item.bundleKey, members);
  }
  return {
    bundles: [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bundleKey, members]) => ({
        bundleKey,
        members: members.sort((left, right) => left.signalId.localeCompare(right.signalId)),
      })),
  };
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
    '处理契约：分页或 10/20/50 条上限只限制单次工具调用或上下文切片，不是任务终点；当班猫必须沿同一责任链持续续跑，直到 active=0，或每个剩余 actionable bundle 均有真实 task + named owner + active F167 lease、等待 operator 审批的 durable proposal，或带证据 ref 的 explicit blocker。signature-waiting 必须继续由合法独立 signer 完成 exact candidate，或转为 explicit blocker，不能提前结账。仅有 owner、task、transport receipt 或 chat prose 都不是终点；预算将尽时必须建立结构化续跑，不得静默等下一轮 cron。',
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

  async claim(
    watermark: string,
    claimedAt: string,
    snapshot: PawFeelDutyBatchSnapshot,
  ): Promise<PawFeelDutyNoticeClaim> {
    const result = (await this.redis.eval(
      CLAIM_LUA,
      1,
      DUTY_NOTICE_KEY,
      watermark,
      claimedAt,
      JSON.stringify(snapshot),
    )) as [number, string, string];
    if (result[0] === 1) return { outcome: 'claimed' };
    if (result[0] === 2) return { outcome: 'resume_invocation', watermark: result[1], messageId: result[2] };
    if (result[0] === 3) return { outcome: 'complete' };
    return { outcome: 'claimed_elsewhere' };
  }

  async readCurrent(): Promise<PawFeelDutyBatchRecord | null> {
    const raw = await this.redis.hgetall(DUTY_NOTICE_KEY);
    if (!raw.watermark || !raw.status || !raw.updatedAt || !raw.snapshot) return null;
    if (!DUTY_BATCH_STATUSES.has(raw.status as PawFeelDutyBatchRecord['status'])) {
      throw new Error('invalid paw-feel duty batch status');
    }
    const snapshot = parseDutyBatchSnapshot(raw.snapshot);
    return {
      watermark: raw.watermark,
      status: raw.status as PawFeelDutyBatchRecord['status'],
      updatedAt: raw.updatedAt,
      ...(raw.messageId ? { messageId: raw.messageId } : {}),
      snapshot,
    };
  }

  async markDelivered(watermark: string, messageId: string, updatedAt: string): Promise<void> {
    const updated = await this.redis.eval(DELIVERED_LUA, 1, DUTY_NOTICE_KEY, watermark, messageId, updatedAt);
    if (updated !== 1) throw new Error('duty notice watermark or state changed before delivery receipt');
  }

  async markAwaitingReceipt(watermark: string, updatedAt: string): Promise<void> {
    const updated = await this.redis.eval(AWAITING_RECEIPT_LUA, 1, DUTY_NOTICE_KEY, watermark, updatedAt);
    if (updated !== 1) throw new Error('duty notice watermark or state changed before awaiting receipt');
  }

  async markComplete(watermark: string, updatedAt: string): Promise<void> {
    const updated = await this.redis.eval(COMPLETE_LUA, 1, DUTY_NOTICE_KEY, watermark, updatedAt);
    if (updated !== 1) throw new Error('duty notice watermark or state changed before completion');
  }
}

export const PawFeelDutyNoticeKey = DUTY_NOTICE_KEY;
