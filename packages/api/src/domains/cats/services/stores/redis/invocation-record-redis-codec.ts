/**
 * F297 (PR #3748 local R12 P1) — invocation record 的**领域 codec**：
 * Redis hash → invocation domain truth 的唯一路径。
 *
 * R7–R12 的 finding 生成器是「transport validity ≠ record validity」：envelope helper
 * （redis-pipeline-reply）收敛了管道回复判据，但 hash → InvocationRecord 的业务判据仍散在
 * listRunningByThread / backfill / scanAll / get 各自手写，每轮 review 都能再找到一个漏掉的
 * 字段。本模块把「合法记录空间」的定义收敛为单一 decode（parse, don't validate）：
 *
 *   pipeline envelope → decodeInvocationHash → absent | running | not_running | throw
 *
 * | arm         | 含义                                            | 消费方允许的动作           |
 * |-------------|-------------------------------------------------|----------------------------|
 * | absent      | 权威空：记录不存在                              | 索引清理（SREM）           |
 * | running     | 完整合法记录，status === 'running'              | 返回给 owner-truth 消费者  |
 * | not_running | 完整合法记录，status ∈ union 且 ≠ 'running'     | 可证明非 live：索引清理    |
 * | throw       | 其余一切（未知）                                | 传播；禁止 SREM / seed 索引 / 标记 backfill 完成 |
 *
 * 注意 not_running ⊃ terminal：`queued` 不是 terminal，但对「是否 live」的判断它同样是
 * 权威的非 running——这正是消费方唯一需要的判定。
 *
 * 严格集（缺失/非法即 throw）= liveness/ownership 判断的输入，且全部是 create-Lua 自诞生
 * 必写的核心身份字段：id（且 === expectedId，key/index parity）· threadId · userId ·
 * status ∈ ALL_STATUSES（domain 真相源，不再手抄）· targetCats（严格 JSON string[]）·
 * createdAt / updatedAt（有限数字）。
 *
 * 展示/遥测字段（usageByCat、successfulCatIds、intent 默认值、freshness 元数据等）保持
 * lenient decode——它们不参与 liveness/ownership 判断；把它们纳入严格集需要先做历史数据
 * 迁移评估，不属于本 codec 的守护目标。分界在此声明，扩集走显式决策而非隐式漂移。
 */

import type { CatId } from '@cat-cafe/shared';
import type { TokenUsage } from '../../types.js';
import {
  type InvocationActionLeaseRef,
  type InvocationRecord,
  type InvocationStatus,
  requireInvocationWaitContinuationCarrier,
} from '../ports/InvocationRecordStore.js';
import { ALL_STATUSES } from '../ports/invocation-state-machine.js';
import { type RedisPipelineEntry, readAuthoritativeHash } from './redis-pipeline-reply.js';

export type DecodedInvocationHash =
  | { kind: 'absent' }
  | { kind: 'running'; record: InvocationRecord }
  | { kind: 'not_running'; record: InvocationRecord };

const STATUS_UNION: ReadonlySet<string> = new Set(ALL_STATUSES);

/**
 * 读一条 invocation record 的 HGETALL pipeline 回复并 decode 到 domain truth。
 *
 * @param expectedId 该 hash 应当持有的 id（索引 member / key 内 id / 调用方请求的 id）。
 *                   hash.id 与它不符 = 索引与记录对不上 = 数据损坏 = 未知。
 * @throws 任何 transport 或 record 层的未知形态——调用方不得把它降级成空/stale。
 */
export function decodeInvocationHash(
  entry: RedisPipelineEntry,
  expectedId: string,
  context: string,
): DecodedInvocationHash {
  const data = readAuthoritativeHash(entry, context);
  if (data === null) return { kind: 'absent' };
  const record = decodeInvocationRecord(data, expectedId, context);
  return record.status === 'running' ? { kind: 'running', record } : { kind: 'not_running', record };
}

/** 非空 hash → 完整合法 InvocationRecord；任何严格集违例 throw。 */
function decodeInvocationRecord(data: Record<string, string>, expectedId: string, context: string): InvocationRecord {
  if (!data.id) throw new Error(`${context}: non-empty hash has no id`);
  if (data.id !== expectedId) {
    throw new Error(`${context}: hash id "${data.id}" does not match the expected id "${expectedId}"`);
  }
  if (!data.threadId) throw new Error(`${context}: record has no threadId (cannot judge ownership)`);
  if (!data.userId) throw new Error(`${context}: record has no userId (cannot judge ownership)`);
  if (data.status === undefined || !STATUS_UNION.has(data.status)) {
    throw new Error(`${context}: unknown status "${data.status}" cannot be read as live or non-live`);
  }
  const targetCats = decodeStrictStringArray(data.targetCats, 'targetCats', context);
  const createdAt = decodeFiniteNumber(data.createdAt, 'createdAt', context);
  const updatedAt = decodeFiniteNumber(data.updatedAt, 'updatedAt', context);

  const errorValue = data.error;
  const hasError = errorValue !== undefined && errorValue !== '';
  const usageByCat = safeParseObject(data.usageByCat);
  const successfulCatIds = data.successfulCatIds
    ? Object.freeze(safeParseArray(data.successfulCatIds) as CatId[])
    : undefined;
  const actionLeaseCarrier = parseActionLeaseCarrier(data.actionLeaseCarrier, data.actionLeaseRef);
  const waitContinuationCarrier = parseStoredWaitContinuationCarrier(data.waitContinuationCarrier);
  return {
    id: data.id,
    threadId: data.threadId,
    userId: data.userId,
    userMessageId: data.userMessageId === '' ? null : (data.userMessageId ?? null),
    targetCats: Object.freeze(targetCats) as CatId[],
    intent: (data.intent as 'execute' | 'ideate') ?? 'execute',
    status: data.status as InvocationStatus,
    ...(successfulCatIds !== undefined ? { successfulCatIds } : {}),
    idempotencyKey: data.idempotencyKey ?? '',
    ...(hasError ? { error: errorValue } : {}),
    ...(data.executionStartedAt ? { executionStartedAt: parseInt(data.executionStartedAt, 10) } : {}),
    ...(usageByCat ? { usageByCat } : {}),
    ...(data.usageRecordedAt ? { usageRecordedAt: parseInt(data.usageRecordedAt, 10) } : {}),
    ...(data.freshnessClosureId ? { freshnessClosureId: data.freshnessClosureId } : {}),
    ...(data.freshnessInputFrontierMessageId
      ? { freshnessInputFrontierMessageId: data.freshnessInputFrontierMessageId }
      : {}),
    ...(data.freshnessClosureStatus
      ? { freshnessClosureStatus: data.freshnessClosureStatus as InvocationRecord['freshnessClosureStatus'] }
      : {}),
    actionLeaseCarrier,
    ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
    createdAt,
    updatedAt,
  };
}

/**
 * 严格 JSON string[] decode：坏 JSON / 非数组 / 非 string 成员都是未知（R11+R12 P1）。
 * 缺失/空串同样未知——create-Lua 自诞生必写该字段（合法空是 `'[]'`，从不是 `''`），
 * 宽容它等于伪造一条「没有目标猫」的记录。
 */
function decodeStrictStringArray(value: string | undefined, field: string, context: string): string[] {
  if (value === undefined || value === '') {
    throw new Error(`${context}: ${field} is missing (a legal empty value would be "[]")`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context}: ${field} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${context}: ${field} is not a JSON array`);
  for (const member of parsed) {
    if (typeof member !== 'string') {
      throw new Error(`${context}: ${field} has a non-string member (got ${typeof member})`);
    }
  }
  return parsed as string[];
}

/**
 * 严格时间戳 decode（R12 P1 / R13 P1-2）：合法空间 = 非负十进制整数字符串
 * （create-Lua 写的是 `String(Date.now())`，别无其他形态）。
 *
 * 不用 `Number()` 当判据——它的宽容面就是漏洞面：`Number(' ') === 0`（空白串
 * 解析成 epoch 0，running record 立刻被判超龄 zombie → false terminal）、
 * `Number('0x10') === 16`、`Number('17e3') === 17000`。正则定义合法，其余全拒。
 */
const DECIMAL_TIMESTAMP = /^\d+$/;
function decodeFiniteNumber(value: string | undefined, field: string, context: string): number {
  if (value === undefined || !DECIMAL_TIMESTAMP.test(value)) {
    throw new Error(`${context}: ${field} "${value ?? ''}" is not a non-negative decimal timestamp`);
  }
  const parsed = Number(value);
  // R14 P1-1：格式合法还不够——`'9007199254740993'` 过正则后 Number 坍缩成 …992，
  // 两个不同的 Redis 字符串变成同一个 JS number，权威 record 的排序/超时判定失去
  // 可逆性。合法空间 = 非负**安全整数**十进制串（isSafeInteger 蕴含 finite）。
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${context}: ${field} "${value}" is not a safe-integer timestamp`);
  }
  return parsed;
}

function parseStoredWaitContinuationCarrier(value: string | undefined): InvocationRecord['waitContinuationCarrier'] {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Stored InvocationRecord has malformed wait continuation carrier JSON');
  }
  return requireInvocationWaitContinuationCarrier(parsed);
}

function parseActionLeaseCarrier(
  value: string | undefined,
  legacyActionLeaseRef: string | undefined,
): InvocationRecord['actionLeaseCarrier'] {
  if (!value) {
    if (!legacyActionLeaseRef) return Object.freeze({ kind: 'none' });
    const legacyRef = parseActionLeaseRef(legacyActionLeaseRef);
    return Object.freeze({ kind: 'action_successor', ...legacyRef });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid persisted InvocationRecord.actionLeaseCarrier JSON');
  }
  if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed && parsed.kind === 'none') {
    return Object.freeze({ kind: 'none' });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kind' in parsed) ||
    parsed.kind !== 'action_successor' ||
    !('leaseId' in parsed) ||
    typeof parsed.leaseId !== 'string' ||
    parsed.leaseId.length === 0 ||
    !('generation' in parsed) ||
    !Number.isInteger(parsed.generation) ||
    (parsed.generation as number) <= 0
  ) {
    throw new Error('Invalid persisted InvocationRecord.actionLeaseCarrier');
  }
  return Object.freeze({
    kind: 'action_successor',
    leaseId: parsed.leaseId,
    generation: parsed.generation as number,
  });
}

function parseActionLeaseRef(value: string): InvocationActionLeaseRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid persisted InvocationRecord.actionLeaseRef JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('leaseId' in parsed) ||
    typeof parsed.leaseId !== 'string' ||
    parsed.leaseId.length === 0 ||
    !('generation' in parsed) ||
    !Number.isInteger(parsed.generation) ||
    (parsed.generation as number) <= 0
  ) {
    throw new Error('Invalid persisted InvocationRecord.actionLeaseRef');
  }
  return Object.freeze({ leaseId: parsed.leaseId, generation: parsed.generation as number });
}

/** Lenient：遥测/展示字段，不参与 liveness 判断（分界见文件头）。 */
function safeParseArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Lenient：遥测/展示字段，不参与 liveness 判断（分界见文件头）。 */
function safeParseObject(value: string | undefined): Record<string, TokenUsage> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, TokenUsage>)
      : null;
  } catch {
    return null;
  }
}
