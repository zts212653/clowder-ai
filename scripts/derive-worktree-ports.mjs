#!/usr/bin/env node
// WORKTREE_PORT_OFFSET 派生函数（F182 大赛基建 + 多 worktree 并发）
// 核心 4 服务：Redis / API / Web / NEXT_PUBLIC_API_URL
// Sidecar 不在范围（大赛 worktree 全禁用）
// 砚砚 review 拍板：cat-cafe/docs/plans/2026-04-30-worktree-port-offset.md

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REDIS_SANCTUM = 6399; // 用户 Redis 圣域，铁律 #1
const REDIS_BASE = 6398;
const API_BASE = 3102;
const WEB_BASE = 5102;

export function validateWorktreeOffset(offset) {
  if (!Number.isInteger(offset)) {
    throw new Error(`WORKTREE_PORT_OFFSET must be integer, got ${offset}`);
  }
  if (offset > 0) {
    throw new Error(`WORKTREE_PORT_OFFSET must be ≤ 0 (圣域 ${REDIS_SANCTUM}), got ${offset}`);
  }
  if (offset < -100) {
    throw new Error(`WORKTREE_PORT_OFFSET range exceeded ([-100, 0]), got ${offset}`);
  }
  if (offset % 10 !== 0) {
    throw new Error(`WORKTREE_PORT_OFFSET must be multiple of 10, got ${offset}`);
  }
}

export function deriveWorktreePorts(offset) {
  validateWorktreeOffset(offset);
  const redis = REDIS_BASE + offset;
  if (redis === REDIS_SANCTUM) {
    throw new Error(`Refusing to assign ${REDIS_SANCTUM} — 圣域`);
  }
  if (redis < 6000) {
    throw new Error(`Redis port ${redis} out of safe range (≥ 6000)`);
  }
  const api = API_BASE - offset;
  return {
    redis,
    api,
    web: WEB_BASE - offset,
    nextPublicApiUrl: `http://localhost:${api}`,
  };
}

// CLI 入口：start-dev.sh 调用 `node scripts/derive-worktree-ports.mjs $OFFSET`
// 输出 shell-eval-able export 行
// 云端 Codex review P1 + 自查发现的更深 macOS symlink 问题：
//   - import.meta.url 是 URL-encoded（空格→%20），process.argv[1] 是原始 filesystem path
//   - macOS 上 import.meta.url 走 realpath（/var → /private/var），argv[1] 不走
//   两边都过 realpathSync 规范化后比较，覆盖空格 + symlink 双重场景。
function isCliEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // realpathSync 失败 fallback 到字符串比较（罕见路径）
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}
if (isCliEntry()) {
  const arg = process.argv[2];
  let offset;
  if (arg === undefined || arg === '') {
    offset = 0;
  } else {
    // 砚砚 review P2: parseInt('-10abc') 会被当 -10 接受，用 Number 严格解析
    offset = Number(arg);
    if (Number.isNaN(offset)) {
      process.stderr.write(`[derive-worktree-ports] 输入不是有效数字: '${arg}'\n`);
      process.exit(2);
    }
  }
  try {
    const ports = deriveWorktreePorts(offset);
    process.stdout.write(
      `export REDIS_PORT=${ports.redis}\n` +
        `export API_SERVER_PORT=${ports.api}\n` +
        `export FRONTEND_PORT=${ports.web}\n` +
        `export NEXT_PUBLIC_API_URL=${ports.nextPublicApiUrl}\n`,
    );
  } catch (err) {
    process.stderr.write(`[derive-worktree-ports] ${err.message}\n`);
    process.exit(2);
  }
}
