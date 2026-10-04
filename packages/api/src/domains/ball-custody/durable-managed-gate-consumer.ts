import { readFileSync } from 'node:fs';
import { createDurableManagedGateJob, type DurableManagedGateJob } from './durable-managed-gate-job.js';
import { type DurableGateFrozenIdentity, readDurableGateRecovery } from './durable-managed-gate-recovery.js';
import type { ManagedCommandTerminalResult } from './managed-command-wake-task-projection.js';

export const DEFAULT_DURABLE_GATE_RECOVERY = Object.freeze({
  protocolVersion: 2 as const,
  eventLoopGapMs: 30_000,
  reconciliationBudgetMs: 30_000,
  pollMs: 250,
  powerEvidenceSource: Object.freeze({ kind: 'mac_pmset' as const }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RISK_AXES = new Set(['behavior', 'data', 'security', 'contract', 'irreversible']);
const MANUALLY_RESUMABLE_TERMINALS = new Set(['failed', 'lost', 'partial', 'timed_out']);
const SAFE_GATE_ENV_UNSETS = new Set(['NODE_ENV', 'REDIS_URL']);
const LOCAL_GATE_REDIS_URL = /^redis:\/\/(?:127\.0\.0\.1|localhost):6398(?:\/(?:0|[1-9][0-9]*))?$/u;
const SIMPLE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/u;
const UNSUPPORTED_SHELL_WHITESPACE = /[^\S \t]/u;

interface GateOptionState {
  risk: boolean;
  resume: boolean;
  sourceFull: boolean;
  separator: boolean;
}

const GATE_VALUE_OPTIONS = {
  '--risk': { key: 'risk', valid: (value: string) => RISK_AXES.has(value) },
  '--resume': { key: 'resume', valid: (value: string) => UUID.test(value) },
  '--source-full': { key: 'sourceFull', valid: (value: string) => /^[0-9a-f]{40}$/u.test(value) },
} as const;

function consumeGateOption(tokens: readonly string[], index: number, state: GateOptionState): number | null {
  const flag = tokens[index];
  if (flag === '--') {
    if (state.separator) return null;
    state.separator = true;
    return index + 1;
  }
  if (!Object.hasOwn(GATE_VALUE_OPTIONS, flag)) return null;
  const option = GATE_VALUE_OPTIONS[flag as keyof typeof GATE_VALUE_OPTIONS];
  if (state[option.key] || !option.valid(tokens[index + 1] ?? '')) return null;
  state[option.key] = true;
  return index + 2;
}

function isSafeGateDataRoot(value: string): boolean {
  if (!SIMPLE_ABSOLUTE_PATH.test(value) || value.includes('//')) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function isSafeGateEnvironmentAssignment(token: string): boolean {
  const separator = token.indexOf('=');
  if (separator <= 0) return false;
  const name = token.slice(0, separator);
  const value = token.slice(separator + 1);
  if (name === 'REDIS_URL') return LOCAL_GATE_REDIS_URL.test(value);
  if (name === 'CAT_CAFE_DATA_DIR') return isSafeGateDataRoot(value);
  return false;
}

function consumeSafeGateAssignments(tokens: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (isSafeGateEnvironmentAssignment(tokens[index] ?? '')) index += 1;
  return index;
}

function consumeSafeEnvPrefix(tokens: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (tokens[index] === '-u') {
    if (!SAFE_GATE_ENV_UNSETS.has(tokens[index + 1] ?? '')) return null;
    index += 2;
  }
  return consumeSafeGateAssignments(tokens, index);
}

function consumeSafeGatePrefix(tokens: readonly string[]): number | null {
  const index = consumeSafeGateAssignments(tokens, 0);
  return tokens[index] === 'env' ? consumeSafeEnvPrefix(tokens, index + 1) : index;
}

function resumableGateTokens(command: string): string[] | null {
  // ManagedRunner executes through a shell. The durable surface intentionally
  // accepts only whitespace-delimited tokens so the persisted command can be
  // reproduced without interpreting quotes, substitutions, redirects or globs.
  if (UNSUPPORTED_SHELL_WHITESPACE.test(command) || /[;&|`$<>()'"\\*?[\]{}!]/u.test(command)) return null;
  const normalized = command.replace(/^[ \t]+|[ \t]+$/gu, '');
  if (!normalized) return null;
  const tokens = normalized.split(/[ \t]+/u);
  const executableIndex = consumeSafeGatePrefix(tokens);
  if (executableIndex === null || tokens[executableIndex] !== 'pnpm') return null;
  let index = tokens[executableIndex + 1] === 'run' ? executableIndex + 2 : executableIndex + 1;
  if (tokens[index] !== 'gate') return null;
  index += 1;
  const state: GateOptionState = { risk: false, resume: false, sourceFull: false, separator: false };
  while (index < tokens.length) {
    const next = consumeGateOption(tokens, index, state);
    if (next === null) return null;
    index = next;
  }
  return tokens;
}

export function isResumableDurableManagedGateCommand(command: string): boolean {
  return resumableGateTokens(command) !== null;
}

export function createResumableDurableManagedGateJob(
  originTaskId: string,
  executionSlaMs: number,
  wakeTarget: DurableManagedGateJob['wakeTarget'],
  dataRoot?: string,
): DurableManagedGateJob {
  const base = createDurableManagedGateJob(originTaskId, executionSlaMs, wakeTarget, dataRoot);
  return { ...base, kind: 'resumable_full_gate_v2', recovery: DEFAULT_DURABLE_GATE_RECOVERY };
}

function withResumeCheckpoint(
  command: string,
  runId: string,
  frozenIdentity: DurableGateFrozenIdentity,
): string | null {
  const tokens = resumableGateTokens(command);
  if (!tokens || !UUID.test(runId)) return null;
  const sourceIndex = tokens.indexOf('--source-full');
  const commandScope = sourceIndex >= 0 ? 'source_full' : 'merge';
  if (commandScope !== (frozenIdentity.verificationScope ?? 'merge')) return null;
  if (sourceIndex >= 0 && tokens[sourceIndex + 1] !== frozenIdentity.headSha) return null;
  const existingIndex = tokens.indexOf('--resume');
  if (existingIndex >= 0) {
    return [...tokens.slice(0, existingIndex + 1), runId, ...tokens.slice(existingIndex + 2)].join(' ');
  }
  return [...tokens, '--resume', runId].join(' ');
}

function gateReceipt(job: DurableManagedGateJob): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(job.gateReceiptPath, 'utf8')) as Record<string, unknown>;
    return value.jobId === job.jobId ? value : null;
  } catch {
    return null;
  }
}

export interface DurableManagedGateConsumerProjection {
  readonly pauseEpoch: number;
  readonly resumeCount: number;
  readonly recoveryState: string;
  readonly blockReason: string | null;
  readonly resumeCommand: string | null;
}

function blockReasonLabel(reason: string | null): string {
  if (reason === 'ambiguous_result') return 'ambiguous_result：原执行结果无法安全归因';
  if (reason === 'child_protocol_unavailable') return 'child_protocol_unavailable：子进程未完成恢复握手';
  if (reason === 'cleanup_unproven') return 'cleanup_unproven：旧执行清理未获证明';
  return '原因不可用';
}

function canOfferExplicitResume(
  recovery: ReturnType<typeof readDurableGateRecovery>,
  runId: string | null,
  terminalStatus: string | null,
  result: ManagedCommandTerminalResult,
): boolean {
  if (!recovery?.frozenIdentity || runId === null || result.cancelled || result.exitCode === 0) return false;
  if (['cleanup_unproven', 'child_protocol_unavailable'].includes(recovery.blockReason ?? '')) return false;
  if (recovery.state === 'blocked' && recovery.blockReason !== 'ambiguous_result') return false;
  if (recovery.terminalIntent === 'cancelled') return false;
  if (recovery.terminalIntent === 'timed_out' && terminalStatus !== 'timed_out') return false;
  if (result.timedOut && terminalStatus !== 'timed_out') return false;
  return terminalStatus === null || MANUALLY_RESUMABLE_TERMINALS.has(terminalStatus);
}

function recoveryProgressLine(projection: DurableManagedGateConsumerProjection): string | null {
  if (projection.resumeCount > 0) {
    return `睡眠恢复：已开始续跑 ${projection.resumeCount} 次（冻结输入保持不变）`;
  }
  if (projection.recoveryState === 'reconciling_clock') {
    return '睡眠恢复：正在核对主机睡眠证据，尚未启动继任执行';
  }
  if (projection.recoveryState === 'reconciling_owner') {
    return '睡眠恢复：正在清理旧执行并对账，尚未启动继任执行';
  }
  if (projection.recoveryState === 'blocked' && projection.pauseEpoch > 0) {
    return '睡眠恢复：恢复已阻塞，未启动继任执行';
  }
  if (projection.pauseEpoch > 0 && projection.recoveryState !== 'terminal_intent') {
    return '睡眠恢复：已检测到暂停边界，尚未启动继任执行';
  }
  return null;
}

export function projectDurableManagedGateConsumer(
  job: DurableManagedGateJob,
  command: string,
  result: ManagedCommandTerminalResult,
): DurableManagedGateConsumerProjection | null {
  if (job.kind !== 'resumable_full_gate_v2' || job.recovery?.protocolVersion !== 2) return null;
  const recovery = readDurableGateRecovery(job);
  const receipt = gateReceipt(job);
  const runId = typeof receipt?.runId === 'string' ? receipt.runId : null;
  const terminalStatus = typeof receipt?.terminalStatus === 'string' ? receipt.terminalStatus : null;
  const recoveryReady = recovery !== null && recovery.frozenIdentity !== null;
  const mayResume = canOfferExplicitResume(recovery, runId, terminalStatus, result);
  return {
    pauseEpoch: recovery?.pauseEpoch ?? 0,
    resumeCount: recovery?.resumeCount ?? 0,
    recoveryState: recoveryReady ? recovery.state : 'unavailable',
    blockReason: recovery?.blockReason ?? null,
    resumeCommand:
      mayResume && runId && recovery?.frozenIdentity
        ? withResumeCheckpoint(command, runId, recovery.frozenIdentity)
        : null,
  };
}

export function durableManagedGateConsumerLines(projection: DurableManagedGateConsumerProjection | null): string[] {
  if (!projection) return [];
  const lines: string[] = [];
  const progress = recoveryProgressLine(projection);
  if (progress) lines.push(progress);
  if (projection.recoveryState === 'unavailable') {
    lines.push('恢复状态：不可用（未找到完整的持久恢复身份；不提供续办入口）');
  }
  if (projection.recoveryState === 'blocked') {
    lines.push(`恢复状态：已阻塞（${blockReasonLabel(projection.blockReason)}）`);
  }
  if (projection.resumeCommand) lines.push(`可执行续办入口：\`${projection.resumeCommand}\``);
  return lines;
}
