/**
 * DARE Agent Service
 * 通过 DARE CLI 子进程调用外部 DARE agent（headless 模式）
 *
 * CLI 调用方式:
 *   python -m client --adapter openrouter --model MODEL \
 *     run --task "prompt" --auto-approve --headless
 *   (API key passed via child process env, not CLI args)
 *
 * NDJSON 事件格式 (headless envelope v1):
 *   session.started  → session_init
 *   tool.invoke      → tool_use
 *   tool.result      → tool_result
 *   task.completed   → text (rendered_output)
 *   task.failed      → error
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { isParseError } from '../../../../../utils/ndjson-parser.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { transformDareEvent } from './dare-event-transform.js';

interface DareAgentServiceOptions {
  catId?: CatId;
  /** DARE adapter: 'openrouter' | 'openai' | 'anthropic' (default: 'openrouter') */
  adapter?: string;
  /** Model name (e.g. 'z-ai/glm-4.7' | 'claude-3-7-sonnet-latest') */
  model?: string;
  /** Optional endpoint override (maps to DARE CLI --endpoint) */
  endpoint?: string;
  /** Generic API key override for any adapter (mapped to adapter-specific env var) */
  apiKey?: string;
  /** Path to DARE repo (used as cwd fallback) */
  darePath?: string;
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
}

const DEFAULT_DARE_PATH = '/tmp/cat-cafe-reviews/Deterministic-Agent-Runtime-Engine';
const DEFAULT_KEY_ENV = 'OPENAI_API_KEY';
const DARE_API_KEY_ENV = 'DARE_API_KEY';
const DARE_ENDPOINT_ENV = 'DARE_ENDPOINT';

const ADAPTER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const ADAPTER_ENDPOINT_ENV: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
};

function resolveDefaultDarePath(): string | undefined {
  return existsSync(join(DEFAULT_DARE_PATH, 'client', '__main__.py')) ? DEFAULT_DARE_PATH : undefined;
}

export class DareAgentService implements AgentService {
  readonly catId: CatId;
  private readonly adapter: string;
  private readonly model: string;
  private readonly endpoint: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly darePath: string | undefined;
  private readonly spawnFn: SpawnFn | undefined;

  constructor(options?: DareAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('dare');
    this.adapter = options?.adapter ?? process.env.DARE_ADAPTER ?? 'openrouter';
    // P1-2: Use unified model resolution chain (env CAT_*_MODEL > cat-config > fallback)
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.endpoint =
      options?.endpoint ?? process.env[DARE_ENDPOINT_ENV] ?? process.env[this.getAdapterEndpointEnvName()];
    this.apiKey = options?.apiKey ?? process.env[DARE_API_KEY_ENV];
    this.darePath = options?.darePath ?? process.env.DARE_PATH ?? resolveDefaultDarePath();
    this.spawnFn = options?.spawnFn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_DARE_MODEL_OVERRIDE ?? this.model;
    // Runtime mode: require resolvable DARE module path to avoid opaque "No module named client".
    // Unit tests pass spawnFn and may not provide a real filesystem path; skip hard check there.
    if (!this.darePath && !this.spawnFn) {
      const metadata: MessageMetadata = { provider: 'dare', model: effectiveModel };
      yield {
        type: 'error',
        catId: this.catId,
        error: `DARE CLI 未配置路径：请设置 DARE_PATH，或在默认路径 ${DEFAULT_DARE_PATH} 放置 DARE 仓库`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }
    if (this.darePath && !this.spawnFn && !existsSync(join(this.darePath, 'client', '__main__.py'))) {
      const metadata: MessageMetadata = { provider: 'dare', model: effectiveModel };
      yield {
        type: 'error',
        catId: this.catId,
        error: `DARE_PATH 无效：${this.darePath}（未找到 client/__main__.py）`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    const endpoint = this.resolveEndpoint(options?.callbackEnv);
    const args = this.buildArgs(prompt, options?.workingDirectory, options?.sessionId, endpoint, effectiveModel);
    // P1-1: cwd must ALWAYS be darePath (where `python -m client` can find the module).
    // Thread's workingDirectory goes to --workspace instead.
    const cwd = this.darePath;
    // P1-3: Pass API key via child env, not CLI args (avoids ps/audit leakage)
    const childEnv = this.buildEnv(options?.callbackEnv);
    const metadata: MessageMetadata = { provider: 'dare', model: effectiveModel };

    try {
      const cliOpts = {
        command: 'python' as const,
        args,
        ...(cwd ? { cwd } : {}),
        env: childEnv,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      for await (const event of events) {
        if (isCliTimeout(event)) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs: event.silenceDurationMs,
              processAlive: event.processAlive,
              lastEventType: event.lastEventType,
              firstEventAt: event.firstEventAt,
              lastEventAt: event.lastEventAt,
              cliSessionId: event.cliSessionId,
              invocationId: event.invocationId,
              rawArchivePath: event.rawArchivePath,
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: this.catId,
            error: `DARE CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        // F118 Phase C: Forward liveness warnings to frontend with catId
        if (isLivenessWarning(event)) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }
        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('DARE CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        // F166: skip parse error sentinels — DARE CLI should always output NDJSON
        if (isParseError(event)) continue;

        const result = transformDareEvent(event, this.catId);
        if (result !== null) {
          if (result.type === 'session_init' && result.sessionId) {
            metadata.sessionId = result.sessionId;
          }
          yield { ...result, metadata };
        }
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private buildArgs(
    prompt: string,
    workspace?: string,
    sessionId?: string,
    endpoint?: string,
    model?: string,
  ): string[] {
    const args = ['-m', 'client'];
    const effectiveModel = model ?? this.model;

    args.push('--adapter', this.adapter);
    args.push('--model', effectiveModel);
    if (endpoint) {
      args.push('--endpoint', endpoint);
    }

    // P1-1: Pass thread's project directory as DARE workspace
    if (workspace) {
      args.push('--workspace', workspace);
    }

    // P1-3: API key is passed via child env (buildEnv), NOT CLI args

    args.push('run');
    if (sessionId) {
      args.push('--session-id', sessionId);
    }
    args.push('--task', prompt, '--auto-approve', '--headless');

    return args;
  }

  private buildEnv(callbackEnv?: Record<string, string>): Record<string, string | null> {
    const env: Record<string, string | null> = { ...callbackEnv };
    // P1-3: Pass API key via env vars (not CLI args) to avoid ps/audit leakage
    const apiKeyEnvName = this.getAdapterApiKeyEnvName();
    const apiKey =
      callbackEnv?.[DARE_API_KEY_ENV] ?? callbackEnv?.[apiKeyEnvName] ?? this.apiKey ?? process.env[apiKeyEnvName];
    if (apiKey) {
      env[apiKeyEnvName] = apiKey;
    }
    // Normalize generic override into provider-specific env only.
    env[DARE_API_KEY_ENV] = null;
    env[DARE_ENDPOINT_ENV] = null;
    return env;
  }

  private getAdapterApiKeyEnvName(): string {
    return ADAPTER_KEY_ENV[this.adapter] ?? DEFAULT_KEY_ENV;
  }

  private getAdapterEndpointEnvName(): string {
    return ADAPTER_ENDPOINT_ENV[this.adapter] ?? 'OPENAI_BASE_URL';
  }

  private resolveEndpoint(callbackEnv?: Record<string, string>): string | undefined {
    const adapterEndpointEnv = this.getAdapterEndpointEnvName();
    return callbackEnv?.[DARE_ENDPOINT_ENV] ?? callbackEnv?.[adapterEndpointEnv] ?? this.endpoint;
  }
}
