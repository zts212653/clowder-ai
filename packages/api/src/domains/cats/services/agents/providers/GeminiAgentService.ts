/**
 * Gemini Agent Service
 * 使用 Gemini CLI 子进程调用暹罗猫 (Gemini)
 *
 * 双 Adapter 架构:
 *   gemini-cli (默认):  spawn 'gemini' CLI + NDJSON → 全自动 headless
 *   antigravity (opt-in): spawn Antigravity IDE → MCP 回传 → 半自动
 *
 * gemini CLI NDJSON 事件格式 (v0.27.2):
 *   init              → session_init (含 session_id)
 *   message/assistant  → text (content 字段)
 *   tool_use           → tool_use
 *   tool_result        → 跳过
 *   message/user       → 跳过 (echo)
 *   result/success     → 跳过
 *   result/error       → error
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { isParseError } from '../../../../../utils/ndjson-parser.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from '../providers/image-cli-bridge.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { isKnownPostResponseCandidatesCrash, isResultErrorEvent, transformGeminiEvent } from './gemini-event-parser.js';

const log = createModuleLogger('gemini-agent');

type GeminiAdapter = 'gemini-cli' | 'antigravity';
/**
 * Options for constructing GeminiAgentService (dependency injection)
 * F32-b: catId and model are constructor parameters
 */
interface GeminiAgentServiceOptions {
  /** F32-b: catId for this instance (default: 'gemini') */
  catId?: CatId;
  /** F32-b: model override (default: resolved via getCatModel) */
  model?: string;
  /** Inject spawn for gemini-cli adapter (via spawnCli) */
  spawnFn?: SpawnFn;
  /** Inject spawn for antigravity adapter (direct child_process.spawn) */
  antigravitySpawnFn?: typeof nodeSpawn;
  /** Override adapter selection (default: GEMINI_ADAPTER env or 'gemini-cli') */
  adapter?: GeminiAdapter;
}

/**
 * Service for invoking Gemini via CLI subprocess (dual adapter).
 * Uses Google AI Pro/Ultra subscription instead of API key.
 */
export class GeminiAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly antigravitySpawnFn: typeof nodeSpawn;
  private readonly adapter: GeminiAdapter;
  constructor(options?: GeminiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('gemini');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
    this.antigravitySpawnFn = options?.antigravitySpawnFn ?? nodeSpawn;
    this.adapter = options?.adapter ?? (process.env.GEMINI_ADAPTER as GeminiAdapter | undefined) ?? 'gemini-cli';
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    if (this.adapter === 'antigravity') {
      yield* this.invokeAntigravity(prompt, options);
    } else {
      yield* this.invokeGeminiCLI(prompt, options);
    }
  }

  private async *invokeGeminiCLI(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_GEMINI_MODEL_OVERRIDE ?? this.model;
    const metadata: MessageMetadata = { provider: 'google', model: effectiveModel };

    // Gemini CLI has no system prompt flag; prepend identity to prompt text
    let effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;

    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    // Gemini CLI -i is prompt-interactive (conflicts with -p), so we pass path hints
    // and include image directories for tool access.
    effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);

    // Gemini CLI supports UUID session resume in headless mode:
    //   gemini --resume <sessionId> -p "<prompt>" -o stream-json
    // Prefer resume when sessionId is available so Gemini follows the same
    // session semantics as Claude/Codex (session-chain + self-heal).
    const modelArgs = ['--model', effectiveModel];
    const args: string[] = options?.sessionId
      ? ['--resume', options?.sessionId!, ...modelArgs, '-p', effectivePrompt, '-o', 'stream-json', '-y']
      : [...modelArgs, '-p', effectivePrompt, '-o', 'stream-json', '-y'];
    for (const dir of imageAccessDirs) {
      args.push('--include-directories', dir);
    }

    try {
      const geminiCommand = resolveCliCommand('gemini');
      if (!geminiCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('gemini'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      let sawResultError = false;
      let sawAssistantText = false;
      let suppressCliExitError = false;
      const cliOpts = {
        command: geminiCommand,
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
            error: `暹罗猫 CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`,
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
          if (sawResultError || suppressCliExitError) continue;
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Gemini CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        // F166: skip parse error sentinels — Gemini CLI should always output NDJSON
        if (isParseError(event)) continue;

        // F8: Capture usage from result/success events before transform drops them
        if (typeof event === 'object' && event !== null) {
          const raw = event as Record<string, unknown>;
          if (raw.type === 'result' && raw.status === 'success') {
            const stats = raw.stats as Record<string, unknown> | undefined;
            if (stats) {
              const usage: TokenUsage = {};
              if (typeof stats.total_tokens === 'number') usage.totalTokens = stats.total_tokens;
              if (typeof stats.input_tokens === 'number') usage.inputTokens = stats.input_tokens;
              if (typeof stats.output_tokens === 'number') usage.outputTokens = stats.output_tokens;
              if (typeof stats.cached_input_tokens === 'number') usage.cacheReadTokens = stats.cached_input_tokens;
              const contextWindow =
                (typeof stats.context_window === 'number' ? stats.context_window : undefined) ??
                (typeof stats.contextWindow === 'number' ? stats.contextWindow : undefined);
              if (contextWindow != null) usage.contextWindowSize = contextWindow;
              metadata.usage = usage;
            }
          }
        }

        if (sawAssistantText && isKnownPostResponseCandidatesCrash(event)) {
          suppressCliExitError = true;
          continue;
        }

        const fromResultError = isResultErrorEvent(event);
        const result = transformGeminiEvent(event, this.catId);
        if (result !== null) {
          if (result.type === 'session_init' && result.sessionId) {
            metadata.sessionId = result.sessionId;
          }
          if (result.type === 'text') {
            // Separate consecutive assistant text turns with paragraph break.
            // Each Gemini message/assistant is a complete turn (unlike Claude's
            // incremental deltas), so direct concatenation loses inter-turn spacing.
            if (sawAssistantText && result.content) {
              yield { ...result, content: `\n\n${result.content}`, metadata };
            } else {
              yield { ...result, metadata };
            }
            sawAssistantText = true;
          } else {
            if (fromResultError && result.type === 'error') {
              sawResultError = true;
            }
            yield { ...result, metadata };
          }
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
      // Guarantee done after error so invoke-single-cat can set isFinal correctly
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private async *invokeAntigravity(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const agMetadata: MessageMetadata = { provider: 'google', model: `${this.model} (antigravity)` };

    if (!options?.callbackEnv) {
      yield {
        type: 'error',
        catId: this.catId,
        error: 'antigravity adapter requires callbackEnv for MCP callback',
        metadata: agMetadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata: agMetadata, timestamp: Date.now() };
      return;
    }

    const sessionId = `antigravity-${randomUUID()}`;
    agMetadata.sessionId = sessionId;
    yield {
      type: 'session_init',
      catId: this.catId,
      sessionId,
      metadata: agMetadata,
      timestamp: Date.now(),
    };

    let spawnError: Error | null = null;

    try {
      const child = this.antigravitySpawnFn('antigravity', ['chat', '--mode', 'agent', prompt], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...options.callbackEnv },
      });
      // Capture async spawn errors (ENOENT etc.) that fire on next tick.
      child.on('error', (err: Error) => {
        spawnError = err;
      });

      // Wire AbortSignal to kill the detached process group
      const pid = child.pid;
      if (pid && options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            try {
              process.kill(-pid, 'SIGTERM');
              log.info({ pid }, `[gemini] Antigravity process group killed via signal`);
            } catch {
              /* already exited */
            }
          },
          { once: true },
        );
      }

      child.unref();
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: `Failed to launch Antigravity: ${err instanceof Error ? err.message : String(err)}`,
        metadata: agMetadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata: agMetadata, timestamp: Date.now() };
      return;
    }

    // Wait one tick — most spawn errors (ENOENT, EACCES) fire here.
    await new Promise((resolve) => process.nextTick(resolve));

    if (spawnError) {
      yield {
        type: 'error',
        catId: this.catId,
        error: `Failed to launch Antigravity: ${(spawnError as Error).message}`,
        metadata: agMetadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata: agMetadata, timestamp: Date.now() };
      return;
    }

    yield {
      type: 'text',
      catId: this.catId,
      content: '暹罗猫已在 Antigravity 中开始工作，结果将通过 MCP 回传到对话中。',
      metadata: agMetadata,
      timestamp: Date.now(),
    };

    yield { type: 'done', catId: this.catId, metadata: agMetadata, timestamp: Date.now() };
  }
}
