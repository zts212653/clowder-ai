#!/usr/bin/env node
// CI 诊断脚本：验证所有 F182 大赛 OFFSET 都能正常派生 + 端口不冲突
// 注意：这是诊断，不是唯一 gate（唯一 gate 是 start-dev.sh 内置 preflight，砚砚 P1-2）

import { deriveWorktreePorts } from './derive-worktree-ports.mjs';

const CONTEST_OFFSETS = [
  { name: 'alpha (reserved)', offset: 0 },
  { name: 'opus-47', offset: -10 },
  { name: 'sonnet', offset: -20 },
  { name: 'glm', offset: -30 },
  { name: 'deepseek', offset: -40 },
  { name: 'kimi', offset: -50 },
  { name: 'qwen', offset: -60 },
];

let hasFailure = false;
const allPorts = new Map(); // port -> [name, kind]

for (const { name, offset } of CONTEST_OFFSETS) {
  try {
    const ports = deriveWorktreePorts(offset);
    console.log(
      `✓ ${name.padEnd(20)} offset=${String(offset).padStart(4)} → ` +
        `Redis=${ports.redis} API=${ports.api} Web=${ports.web} URL=${ports.nextPublicApiUrl}`,
    );
    // 端口跨选手冲突检测
    for (const [kind, port] of [
      ['redis', ports.redis],
      ['api', ports.api],
      ['web', ports.web],
    ]) {
      const existing = allPorts.get(port);
      if (existing) {
        console.error(`✗ Port ${port} (${kind}) 冲突: ${name} vs ${existing[0]} (${existing[1]})`);
        hasFailure = true;
      } else {
        allPorts.set(port, [name, kind]);
      }
    }
  } catch (err) {
    console.error(`✗ ${name.padEnd(20)} offset=${offset} → ${err.message}`);
    hasFailure = true;
  }
}

if (hasFailure) {
  console.error('\n[check:worktree-port-offset] 失败 — 见上');
  process.exit(1);
} else {
  console.log(`\n[check:worktree-port-offset] ${CONTEST_OFFSETS.length} 个 offset 全通过，端口无冲突`);
}
