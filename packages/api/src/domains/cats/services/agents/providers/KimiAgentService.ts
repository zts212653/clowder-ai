/**
 * Kimi Agent Service
 * 使用官方 kimi-cli 子进程调用 Kimi Code CLI（print mode + stream-json）
 *
 * CLI 调用方式:
 *   kimi --print --output-format stream-json --prompt "prompt"
 *   kimi --session SESSION_ID --print --output-format stream-json --prompt "prompt"
 *
 * stream-json 事件格式:
 *   {"role":"assistant","content":"..."}                     → text
 *   {"role":"assistant","content":"...","tool_calls":[...]} → text + tool_use
 *
 * 会话恢复:
 *   kimi print 模式不会显式输出 session_id。
 *   我们在 resume 时立即回放 session_init；新会话完成后从 ~/.kimi/kimi.json
 *   读取当前 working directory 的 last_session_id 并补发 session_init。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';

const log = createModuleLogger('kimi-agent');
const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

interface KimiAgentServiceOptions {
  catId?: CatId;
  model?: string;
  spawnFn?: SpawnFn;
}

interface KimiPrintMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw };
  }
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const block = item as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function resolveKimiShareDir(callbackEnv?: Record<string, string>): string {
  return callbackEnv?.KIMI_SHARE_DIR || process.env.KIMI_SHARE_DIR || resolve(homedir(), '.kimi');
}

function readKimiSessionId(workingDirectory: string, callbackEnv?: Record<string, string>): string | undefined {
  const shareDir = resolveKimiShareDir(callbackEnv);
  const statePath = join(shareDir, 'kimi.json');
  if (!existsSync(statePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { work_dirs?: Array<Record<string, unknown>> };
    const workDirs = Array.isArray(raw?.work_dirs) ? raw.work_dirs : [];
    const target = resolve(workingDirectory);
    const entry = workDirs.find((item) => typeof item.path === 'string' && resolve(item.path) === target);
    return typeof entry?.last_session_id === 'string' && entry.last_session_id.trim().length > 0
      ? entry.last_session_id
      : undefined;
  } catch {
    return undefined;
  }
}

function buildProjectMcpArgs(workingDirectory?: string): string[] {
  if (!workingDirectory) return [];
  const mcpConfigPath = join(workingDirectory, '.kimi', 'mcp.json');
  return existsSync(mcpConfigPath) ? ['--mcp-config-file', mcpConfigPath] : [];
}

function buildInlineApiKeyConfig(model: string, callbackEnv?: Record<string, string>): string | null {
  const apiKey = callbackEnv?.CAT_CAFE_KIMI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = callbackEnv?.CAT_CAFE_KIMI_BASE_URL || DEFAULT_KIMI_BASE_URL;
  return JSON.stringify({
    providers: {
      'cat-cafe-kimi': {
        type: 'kimi',
        base_url: baseUrl,
        api_key: apiKey,
      },
    },
    models: {
      'cat-cafe-kimi-model': {
        provider: 'cat-cafe-kimi',
        model,
        max_context_size: 262144,
      },
    },
    default_model: 'cat-cafe-kimi-model',
  });
}

export class KimiAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;

  constructor(options?: KimiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('kimi');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_KIMI_MODEL_OVERRIDE ?? this.model;
    const metadata: MessageMetadata = { provider: 'kimi', model: effectiveModel };
    const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const workingDirectory = options?.workingDirectory ?? process.cwd();

    const args = ['--print', '--output-format', 'stream-json', '--model', effectiveModel];
    if (options?.sessionId) {
      args.push('--session', options.sessionId);
      metadata.sessionId = options.sessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: options.sessionId,
        metadata,
        timestamp: Date.now(),
      };
    }
    args.push('--work-dir', workingDirectory);
    args.push(...buildProjectMcpArgs(workingDirectory));
    const inlineConfig = buildInlineApiKeyConfig(effectiveModel, options?.callbackEnv);
    if (inlineConfig) {
      args.push('--config', inlineConfig);
    }
    args.push('--prompt', effectivePrompt);

    try {
      const kimiCommand = resolveCliCommand('kimi');
      if (!kimiCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('kimi'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      let emittedSessionInit = Boolean(options?.sessionId);
      const cliOpts = {
        command: kimiCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv ? { env: options.callbackEnv } : {}),
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
            error: `Kimi CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (isLivenessWarning(event)) {
          const warningEvent = event as { level?: string; silenceDurationMs?: number };
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: warningEvent.level,
              silenceMs: warningEvent.silenceDurationMs,
            },
            '[KimiAgent] liveness warning — CLI may be stuck',
          );
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
            error: formatCliExitError('Kimi CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        const msg = event as KimiPrintMessage;
        if (msg?.role !== 'assistant') continue;

        const content = extractTextContent(msg.content);
        if (content) {
          yield {
            type: 'text',
            catId: this.catId,
            content,
            metadata,
            timestamp: Date.now(),
          };
        }

        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue;
          const call = toolCall as Record<string, unknown>;
          const fn = call.function;
          if (!fn || typeof fn !== 'object') continue;
          const functionCall = fn as Record<string, unknown>;
          const toolName = typeof functionCall.name === 'string' ? functionCall.name : null;
          if (!toolName) continue;
          yield {
            type: 'tool_use',
            catId: this.catId,
            toolName,
            toolInput: parseToolArguments(functionCall.arguments),
            metadata,
            timestamp: Date.now(),
          };
        }
      }

      if (!emittedSessionInit) {
        const inferredSessionId = readKimiSessionId(workingDirectory, options?.callbackEnv);
        if (inferredSessionId) {
          metadata.sessionId = inferredSessionId;
          emittedSessionInit = true;
          yield {
            type: 'session_init',
            catId: this.catId,
            sessionId: inferredSessionId,
            metadata,
            timestamp: Date.now(),
          };
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
}
