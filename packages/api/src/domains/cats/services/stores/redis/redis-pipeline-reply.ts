/**
 * F297 (PR #3748 R10 P1-1) — pipeline 回复的**单一判据**。
 *
 * 「读失败被当成空集合」在本 PR 里反复出现（strict/fail-open、SCARD、child pipeline、
 * record pipeline、thread activity pipeline）。每次都在各自的 store 里手写判断，于是每次
 * 都漏一两种形态：`null` 被 `!hash` 吞掉、`typeof [] === 'object'` 让数组通过、
 * 非空但 hydrate 不出来的损坏 hash 被当 stale 并**永久 SREM**。
 *
 * 判据只写一遍，三个 store 共用：
 *
 * | 回复形态                              | 含义                    | 处置 |
 * |---------------------------------------|-------------------------|------|
 * | 缺 entry / 短 reply                   | 未知                    | throw |
 * | entry error                           | 未知                    | throw |
 * | `null` / `undefined`                  | 未知（HGETALL 不返回它）| throw |
 * | 非 plain object（string / array / …） | 未知（协议异常）        | throw |
 * | plain object 且 0 key（`{}`）         | **权威**：记录不存在    | 权威空 |
 * | plain object 有内容                   | 有记录                  | 交调用方判定 |
 *
 * 「权威」的含义：Redis 明确告诉我们这个 key 没有内容。只有权威信息才能推出
 * 「没在跑」；未知一律抛出，让上层 completeness 记账封 idle——**未知不得当成否定**。
 */

export type RedisPipelineEntry = [Error | null | undefined, unknown] | undefined;

/**
 * 非 plain object 的一切都不是合法 HGETALL 回复。
 *
 * 必须查 prototype：`new Date(0)` 是 object、非 array、`Object.keys()` 又是空，
 * 只查前两项会把它判成「权威空」——一个协议异常被当成「记录不存在」（R11 P1-1）。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 读一条 HGETALL pipeline 回复。
 *
 * @returns 有内容的 hash；`null` 表示**权威空**（记录已不存在）。
 * @throws 任何"未知"形态——调用方不得把它降级成空。
 */
export function readAuthoritativeHash(entry: RedisPipelineEntry, context: string): Record<string, string> | null {
  if (!entry) throw new Error(`${context}: pipeline reply missing (short reply)`);
  const [error, data] = entry;
  if (error) throw error;
  if (data === null || data === undefined) throw new Error(`${context}: pipeline reply was null`);
  if (!isPlainObject(data)) {
    throw new Error(`${context}: pipeline reply was not a hash (got ${Array.isArray(data) ? 'array' : typeof data})`);
  }
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  // Redis hash 的每个 field 都必须是 string。非 string value 说明这不是真实 HGETALL 回复
  // （例如被 stub / 协议损坏），属未知，不能让调用方按业务字段去解读它。
  for (const [field, value] of entries) {
    if (typeof value !== 'string') {
      throw new Error(`${context}: hash field "${field}" is not a string (got ${typeof value})`);
    }
  }
  return data as Record<string, string>;
}

/**
 * 读一条 SMEMBERS pipeline 回复。空数组是权威空；非数组一律未知。
 */
export function readAuthoritativeMembers(entry: RedisPipelineEntry, context: string): string[] {
  if (!entry) throw new Error(`${context}: pipeline reply missing (short reply)`);
  const [error, data] = entry;
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error(`${context}: pipeline reply was not a set (got ${typeof data})`);
  for (const member of data) {
    if (typeof member !== 'string') {
      throw new Error(`${context}: set member is not a string (got ${typeof member})`);
    }
  }
  return data as string[];
}
