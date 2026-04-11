/**
 * Environment check logic for bootcamp.
 * Shared between GET /api/bootcamp/env-check and POST /api/callbacks/bootcamp-env-check.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveDefaultClaudeMcpServerPath } from '../agents/providers/ClaudeAgentService.js';

const execAsync = promisify(exec);

export interface EnvCheckItem {
  ok: boolean;
  version?: string;
  note?: string;
}

export interface EnvCheckResult {
  node: EnvCheckItem;
  pnpm: EnvCheckItem;
  git: EnvCheckItem;
  claudeCli: EnvCheckItem;
  codexCli: EnvCheckItem;
  geminiCli: EnvCheckItem;
  kimiCli: EnvCheckItem;
  mcp: EnvCheckItem;
  tts: { ok: boolean; recommended: string };
  asr: { ok: boolean };
  pencil: { ok: boolean; note: string };
}

async function checkCommand(cmd: string): Promise<EnvCheckItem> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    const version = stdout.trim().split('\n').at(0) ?? '';
    return version ? { ok: true, version } : { ok: true };
  } catch {
    return { ok: false };
  }
}

async function checkPort(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function runEnvironmentCheck(): Promise<EnvCheckResult> {
  const [node, pnpm, git, claudeCli, codexCli, geminiCli, kimiCli] = await Promise.all([
    checkCommand('node --version'),
    checkCommand('pnpm --version'),
    checkCommand('git --version'),
    checkCommand('claude --version'),
    checkCommand('codex --version'),
    checkCommand('gemini --version'),
    checkCommand('kimi --version'),
  ]);

  const mcpPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
  const mcp: EnvCheckItem = mcpPath
    ? { ok: true, note: `MCP server found: ${mcpPath}` }
    : { ok: false, note: 'MCP server not found (packages/mcp-server/dist/index.js)' };

  const [ttsPort, asrPort] = await Promise.all([checkPort(9879), checkPort(9876)]);

  return {
    node,
    pnpm,
    git,
    claudeCli,
    codexCli,
    geminiCli,
    kimiCli,
    mcp,
    tts: {
      ok: ttsPort,
      recommended: ttsPort ? 'Qwen3-TTS 1.7B (已运行)' : 'Kokoro-82M (轻量推荐): mlx-community/Kokoro-82M-bf16',
    },
    asr: { ok: asrPort },
    pencil: { ok: false, note: '需要 Antigravity IDE + Pencil 扩展' },
  };
}
