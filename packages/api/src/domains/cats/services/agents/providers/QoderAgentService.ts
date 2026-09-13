/**
 * F317 Phase 1 Slice 1: 窄 QoderAgentService（非路由）—— round-2 rework
 *
 * I-4 边界：typed 构造注入（catId / binary / model / I-11 profile + fs）；
 * 缺 workingDirectory fail closed。Round-2 review 修正（砚砚 7xP1）：
 *   1. model 为必填 typed input，显式 `-m` 下发并传入 init 门（Auto 静默回落红）；
 *      tools/mcp_servers 字段必须**存在且为空数组**（缺失即红，不 `?? []` 放行）
 *   2. spawn 前构造 PreparedProviderRequestV1 并 await beforeProviderLaunch ——
 *      recorder 拒绝/失败时 0 spawn、正文绝不出境
 *   3. abort 检查先于 spawn；取消用 bounded termination（SIGTERM → 等待 → SIGKILL）
 *   4. 真·流式输出：init 过门后逐条 yield；诊断仅保留有界 ring buffer
 *   5. stderr 先过共享 sanitizeCliStderr + 凭证形态 redact，再截断
 *   6. env denylist 大小写归一（node_options / Node_Options 全拒）
 *   7. （qoder-runtime-profile.ts）swap 失败路径 finally 清理 staging/backup，无凭证孤儿
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CatId } from '@cat-cafe/shared';
import type {
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  PreparedProviderRequestV1,
  TokenUsage,
} from '../../types.js';
import {
  checkQoderProtocolVersion,
  extractQoderUsage,
  isQoderResultErrorEvent,
  type QoderBillingMetadata,
  transformQoderEvent,
} from './qoder-ndjson-parser.js';
import { auditQoderProfile, defaultQoderProfileFs, type QoderProfileFs } from './qoder-runtime-profile.js';

const REQUIRED_PERMISSION_MODE = 'default';
/** abort 后 SIGTERM 的升级等待（ms），超时 SIGKILL —— 不留后台计费 */
const TERMINATION_GRACE_MS = 5000;
/** stderr 诊断 ring 上限（字符） */
const STDERR_RING_LIMIT = 8192;

const DENIED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PRELOAD',
  'NODE_REQUIRE_MODULE',
  'ELECTRON_RUN_AS_NODE',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

export interface QoderAgentServiceConfig {
  catId: CatId;
  /** I-11 runtime profile 目录（由 resolver 经 ensureQoderRuntimeProfile 提供并审计） */
  profileDir: string;
  /** 必填：显式选定并下发 `-m` 的 model（P1-D：Auto 静默回落判失败） */
  model: string;
  /** 可选覆盖 binary（默认 resolveCliCommand('qodercn')；测试注入用） */
  binary?: string;
  /** 注入 spawn（测试） */
  spawnFn?: (cmd: string, args: string[], opts: object) => ChildProcessWithoutNullStreams;
  /** 注入 profile 审计文件系统（测试；默认真实 fs） */
  profileFs?: QoderProfileFs;
}

/** 构造 qodercn argv（stdin prompt 通道 + 显式 model + 安全 flag 全集） */
export function buildQoderArgs(input: { profileDir: string; model: string; sessionId?: string }): string[] {
  const args = ['-p', '-', '-m', input.model, '-o', 'stream-json', '--config-dir', input.profileDir];
  if (input.sessionId) args.push('-r', input.sessionId);
  args.push('--strict-mcp-config', '--allowed-mcp-server-names', 'nothing', '--tools', '', '--setting-sources', 'user');
  return args;
}

/** 大小写归一：qoder 前缀 + denylist（node_options / Node_Options / LD_PRELOAD 全拒） */
export function sanitizeQoderEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (DENIED_ENV_KEYS.has(k.toUpperCase())) continue;
    if (k.toLowerCase().startsWith('qoder')) continue;
    clean[k] = v;
  }
  return clean;
}

/** init 门（任何 assistant 事件之前，fail closed）。tools/mcp 必须存在且精确为空数组。 */
export function qoderInitGate(
  initEvent: unknown,
  requestedModel: string,
): { ok: true; cliDrift?: string; model?: string } | { ok: false; reason: string } {
  const version = checkQoderProtocolVersion(initEvent);
  if (!version.ok) return version;
  if (typeof initEvent !== 'object' || initEvent === null) return { ok: false, reason: 'init missing' };
  const e = initEvent as Record<string, unknown>;
  if (e.permissionMode !== REQUIRED_PERMISSION_MODE) {
    return { ok: false, reason: `permissionMode ${String(e.permissionMode)} != ${REQUIRED_PERMISSION_MODE}` };
  }
  if (!Array.isArray(e.tools)) return { ok: false, reason: 'init.tools missing (not an array)' };
  if (e.tools.length !== 0) return { ok: false, reason: `tools not empty: ${JSON.stringify(e.tools)}` };
  if (!Array.isArray(e.mcp_servers)) return { ok: false, reason: 'init.mcp_servers missing (not an array)' };
  if (e.mcp_servers.length !== 0)
    return { ok: false, reason: `mcp_servers not empty: ${JSON.stringify(e.mcp_servers)}` };
  // 大小写不敏感（L1 实测：请求 Auto，CLI init 回报 auto —— 同一标识符的两种拼写，非静默回落）
  const actualModel = e.model;
  if (typeof actualModel !== 'string' || actualModel.toLowerCase() !== requestedModel.toLowerCase()) {
    return { ok: false, reason: `model ${String(actualModel)} != requested ${requestedModel} (silent fallback)` };
  }
  return {
    ok: true,
    cliDrift: 'cliDrift' in version ? version.cliDrift : undefined,
    model: typeof actualModel === 'string' ? actualModel : undefined,
  };
}

/** stderr 诊断：共享 sanitizer + 凭证形态 redact + 有界 ring */
async function sanitizeStderrLine(line: string): Promise<string> {
  let out = line;
  try {
    const mod = await import('../../../../../utils/sanitize-cli-stderr.js');
    out = mod.sanitizeCliStderr(out, {});
  } catch {
    /* sanitizer 不可用时继续走自有 redact */
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1<redacted>').replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-<redacted>');
}

class StderrRing {
  private parts: string[] = [];
  private size = 0;
  push(s: string): void {
    this.parts.push(s);
    this.size += s.length;
    while (this.size > STDERR_RING_LIMIT && this.parts.length > 1) {
      this.size -= this.parts[0].length;
      this.parts.shift();
    }
  }
  tail(): string {
    return this.parts.join('').trim().slice(-500);
  }
}

export class QoderAgentService implements AgentService {
  private readonly config: QoderAgentServiceConfig;

  constructor(config: QoderAgentServiceConfig) {
    this.config = config;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const workingDirectory = options?.workingDirectory;
    if (!workingDirectory) {
      yield this.error('qoder invoke rejected: workingDirectory is required (fail closed)');
      return;
    }
    const fs = this.config.profileFs ?? defaultQoderProfileFs();
    const audit = auditQoderProfile(this.config.profileDir, fs);
    if (!audit.ok) {
      yield this.error(`qoder invoke rejected: runtime profile audit failed: ${audit.violations.join('; ')}`);
      return;
    }

    // F299：正文/runtime/tool surface 形成后、spawn 前过 recorder —— 拒绝即 0 spawn
    if (options?.beforeProviderLaunch) {
      const prepared: PreparedProviderRequestV1 = {
        v: 1,
        message: { accuracy: 'exact', body: prompt },
        nativeInstructions: [],
        runtime: {
          provider: 'qoder',
          carrier: 'qodercn-cli',
          model: this.config.model,
          protocol: 'stream-json/1.4.0',
          toolExecutionPolicy: 'read_only',
        },
        tools: { finalSurface: 'declared_only', declaredServerNames: [] },
        providerNativeVisibility: 'unknown',
      };
      try {
        await options.beforeProviderLaunch(prepared);
      } catch (err) {
        yield this.error(`qoder invoke rejected by provider-request recorder: ${String(err)}`);
        return;
      }
    }

    // abort 检查先于 spawn：已取消的请求绝不出境
    const signal = options?.signal;
    if (signal?.aborted) {
      yield this.error('qoder invoke aborted before spawn');
      return;
    }

    let binary = this.config.binary;
    if (!binary) {
      const { resolveCliCommand } = await import('../../../../../utils/cli-resolve.js');
      const resolved = resolveCliCommand('qodercn');
      if (!resolved) {
        yield this.error('qoder binary not found (resolveCliCommand(qodercn) returned null)');
        return;
      }
      binary = resolved;
    }
    const args = buildQoderArgs({
      profileDir: this.config.profileDir,
      model: this.config.model,
      sessionId: options?.sessionId,
    });
    const env = sanitizeQoderEnv({ ...process.env, ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.config.spawnFn ?? spawn)(binary, args, {
        cwd: workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield this.error(`qoder spawn failed: ${String(err)}`);
      return;
    }

    child.stdin.write(prompt);
    child.stdin.end();

    const onAbort = () => terminateBounded(child);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      yield* this.consumeStream(child);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!child.killed) terminateBounded(child);
    }
  }

  /** 真·流式：init 过门后逐条 yield；终态在流后收敛判定 */
  private async *consumeStream(child: ChildProcessWithoutNullStreams): AsyncIterable<AgentMessage> {
    const { catId, model } = this.config;
    const rl = createInterface({ input: child.stdout });
    const stderrRing = new StderrRing();
    const stderrSanitized: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderrSanitized.push(d);
      void sanitizeStderrLine(d).then((s) => stderrRing.push(s));
    });

    let initSeen = false;
    let usage: TokenUsage | undefined;
    let billing: QoderBillingMetadata | undefined;
    let resultError: string | undefined;
    let successResultSeen = false;
    let actualModel: string | undefined;
    let exitCode: number | null | undefined;
    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      exitCode = code;
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const e = event as Record<string, unknown>;

        if (e.type === 'system' && e.subtype === 'init') {
          const gate = qoderInitGate(event, model);
          if (!gate.ok) {
            resultError = `qoder init gate failed (fail closed): ${gate.reason}`;
            terminateBounded(child);
            break;
          }
          initSeen = true;
          actualModel = gate.model;
          const initOut = transformQoderEvent(event, catId);
          if (initOut) yield* flat(initOut);
          if (gate.cliDrift) {
            yield {
              type: 'system_info',
              catId,
              content: JSON.stringify({ type: 'qoder_cli_drift', catId, warning: gate.cliDrift }),
              timestamp: Date.now(),
            };
          }
          continue;
        }
        if (!initSeen && (e.type === 'assistant' || e.type === 'user')) {
          resultError = 'qoder stream violated ordering: assistant/user event before passing init gate';
          terminateBounded(child);
          break;
        }
        if (e.type === 'result') {
          if (isQoderResultErrorEvent(e)) {
            resultError = `qoder result error: ${typeof e.result === 'string' ? e.result : 'unknown'}`;
            continue;
          }
          const extracted = extractQoderUsage(e);
          usage = extracted.usage;
          billing = extracted.billing;
          successResultSeen = true;
          continue;
        }
        const out = transformQoderEvent(event, catId);
        if (out) yield* flat(out);
      }
    } catch (err) {
      resultError = resultError ?? `stream read failed: ${String(err)}`;
    }
    rl.close();

    for (let i = 0; i < 250 && exitCode === undefined && !spawnError; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    if (spawnError) {
      yield this.error(`qoder process error: ${String(spawnError)}`);
      return;
    }
    if (resultError) {
      yield this.error(withDiag(resultError, stderrRing));
      return;
    }
    if (!initSeen) {
      yield this.error(withDiag('qoder stream ended without init event (fail closed)', stderrRing));
      return;
    }
    if (!successResultSeen) {
      yield this.error(withDiag('qoder stream ended without a successful result event', stderrRing));
      return;
    }
    if (exitCode !== 0) {
      yield this.error(withDiag(`qoder exited with code ${String(exitCode)}`, stderrRing));
      return;
    }

    const done: AgentMessage = { type: 'done', catId, timestamp: Date.now() };
    done.metadata = {
      provider: 'qoder',
      model: actualModel ?? 'unknown',
      usage,
      ...(billing ? { qoderBilling: billing } : {}),
    } as unknown as NonNullable<AgentMessage['metadata']>;
    yield done;
  }

  private error(message: string): AgentMessage {
    return { type: 'error', catId: this.config.catId, error: message, timestamp: Date.now() };
  }
}

async function* flat(out: AgentMessage | AgentMessage[]): AsyncGenerator<AgentMessage> {
  if (Array.isArray(out)) {
    for (const m of out) yield m;
  } else {
    yield out;
  }
}

function withDiag(message: string, ring: StderrRing): string {
  const tail = ring.tail();
  return tail ? `${message} | stderr tail: ${tail}` : message;
}

/** bounded termination：SIGTERM → 等待 close → 超时 SIGKILL */
function terminateBounded(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  child.kill('SIGTERM');
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, TERMINATION_GRACE_MS);
  child.once('close', () => clearTimeout(killer));
}
