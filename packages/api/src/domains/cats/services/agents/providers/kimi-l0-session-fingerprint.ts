/**
 * F274 follow-up（愿景守护 Terra BLOCKED）— kimi resume 的 L0 新鲜度守卫。
 *
 * kimi-code 在 session 首 bind 冻结 agent prompt（F274 实证）：`--session`
 * resume 会静默沿用会话创建时的旧 L0，模板/家规/安全更新在存量会话里
 * 不生效——这正是 F203 要消灭的静默治理漂移。
 *
 * 机制：每次 native 调用编译 L0 后算 sha256 指纹；resume 前与 store 中该
 * sessionId 首次绑定时记录的指纹比对——一致才传 `--session`；不一致
 * （stale）或无记录（unverifiable，含 F274 之前创建的老会话）一律起
 * fresh session 重新首 bind，并显式 emit `l0_resume_fresh_start` 事件，
 * 把上下文连续性的损失摆到明面。指纹只覆盖编译后 L0（身份/家规/治理），
 * 不覆盖 pack——pack 是路由层每次调用本就允许变化的内容。
 *
 * 隔离（愿景守护 Terra 护栏①）：store key 为 `catId:sessionId`——同一
 * sessionId 在不同猫之间永不匹配（L0 不同则指纹不同，必然 fresh start，
 * key 隔离只是把这个安全方向显式化）；用户级隔离由 KIMI_SHARE_DIR 本身
 * （per-user home 或 callbackEnv override）承担。
 *
 * Store：`<KIMI_SHARE_DIR>/cat-cafe-l0-session-fingerprints.json`，
 * tmp+rename 原子写，last-writer-wins（同一 sessionId 不应并发调用）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STORE_BASENAME = 'cat-cafe-l0-session-fingerprints.json';

export interface KimiL0SessionFingerprintEntry {
  fingerprint: string;
  catId: string;
  updatedAt: number;
}

export type KimiL0SessionFingerprintMap = Record<string, KimiL0SessionFingerprintEntry>;

/** sha256 of the compiled L0 (identity/家规/治理); pack is intentionally excluded. */
export function computeKimiL0Fingerprint(l0: string): string {
  return createHash('sha256').update(l0).digest('hex').slice(0, 16);
}

function storePath(shareDir: string): string {
  return join(shareDir, STORE_BASENAME);
}

export function readKimiL0SessionFingerprints(shareDir: string): KimiL0SessionFingerprintMap {
  try {
    if (!existsSync(storePath(shareDir))) return {};
    const raw = JSON.parse(readFileSync(storePath(shareDir), 'utf8')) as {
      sessions?: KimiL0SessionFingerprintMap;
    };
    return raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  } catch {
    // Corrupt store → every session is unverifiable → fresh start everywhere.
    return {};
  }
}

function storeKey(catId: string, sessionId: string): string {
  return `${catId}:${sessionId}`;
}

export function lookupKimiL0Fingerprint(shareDir: string, catId: string, sessionId: string): string | undefined {
  return readKimiL0SessionFingerprints(shareDir)[storeKey(catId, sessionId)]?.fingerprint;
}

export function recordKimiL0Fingerprint(shareDir: string, catId: string, sessionId: string, fingerprint: string): void {
  try {
    mkdirSync(shareDir, { recursive: true });
    const sessions = readKimiL0SessionFingerprints(shareDir);
    sessions[storeKey(catId, sessionId)] = { fingerprint, catId, updatedAt: Date.now() };
    const tmp = `${storePath(shareDir)}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions }), 'utf8');
    renameSync(tmp, storePath(shareDir));
  } catch {
    // best-effort: a lost record only forces a later fresh start (safe direction)
  }
}
