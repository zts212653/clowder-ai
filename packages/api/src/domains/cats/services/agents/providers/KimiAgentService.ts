/** Kimi Agent Service — kimi-cli subprocess via print mode + stream-json. */

import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { resolveDefaultClaudeMcpServerPath } from './ClaudeAgentService.js';
import { collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import {
  buildApiKeyEnv,
  buildProjectMcpArgs,
  readKimiContextUsedTokens,
  readKimiModelConfigInfo,
  readKimiSessionId,
  resolveKimiModelAlias,
  writeMcpConfigFile,
} from './kimi-config.js';
import {
  buildKimiPrompt,
  extractTextContent,
  extractThinkingContent,
  type KimiPrintMessage,
  parseToolArguments,
  parseUsage,
  readSessionIdFromMessage,
} from './kimi-event-parser.js';

const log = createModuleLogger('kimi-agent');

interface KimiAgentServiceOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  mcpServerPath?: string;
}

export class KimiAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly mcpServerPath: string | undefined;

  constructor(options?: KimiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('kimi');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.mcpServerPath =
      options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH ?? resolveDefaultClaudeMcpServerPath();
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const requestedModel = options?.callbackEnv?.CAT_CAFE_KIMI_MODEL_OVERRIDE ?? this.model;
    const effectiveModel = resolveKimiModelAlias(requestedModel, options?.callbackEnv);
    const metadata: MessageMetadata = { provider: 'kimi', model: effectiveModel };
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    const effectivePrompt = buildKimiPrompt(prompt, options?.systemPrompt, imagePaths);
    const workingDirectory = options?.workingDirectory ?? process.cwd();
    const apiKeyEnv = buildApiKeyEnv(effectiveModel, options?.callbackEnv);
    const tempMcpConfig = this.mcpServerPath
      ? writeMcpConfigFile(workingDirectory, this.mcpServerPath, options?.callbackEnv)
      : null;
    const modelConfig = readKimiModelConfigInfo(effectiveModel, options?.callbackEnv);
    const supportsThinking =
      modelConfig.capabilities.includes('thinking') ||
      apiKeyEnv?.KIMI_MODEL_CAPABILITIES?.includes('thinking') === true;
    const supportsImageInput =
      modelConfig.capabilities.includes('image_in') ||
      apiKeyEnv?.KIMI_MODEL_CAPABILITIES?.includes('image_in') === true;

    const args = ['--print', '--output-format', 'stream-json'];
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
    if (supportsThinking || modelConfig.defaultThinking) {
      args.push('--thinking');
    }
    if (tempMcpConfig) {
      args.push('--mcp-config-file', tempMcpConfig);
    } else {
      args.push(...buildProjectMcpArgs(workingDirectory));
    }
    for (const dir of imageAccessDirs) {
      args.push('--add-dir', dir);
    }
    if (!apiKeyEnv) {
      args.push('--model', effectiveModel);
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
      let sawThinking = false;
      let emittedImageCapability = false;
      const cliOpts = {
        command: kimiCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv || apiKeyEnv
          ? { env: { ...(options?.callbackEnv ?? {}), ...(apiKeyEnv ?? {}) } }
          : {}),
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
          const {
            silenceDurationMs,
            processAlive,
            lastEventType,
            firstEventAt,
            lastEventAt,
            cliSessionId: csId,
            invocationId: invId,
            rawArchivePath,
          } = event;
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            timestamp: Date.now(),
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs,
              processAlive,
              lastEventType,
              firstEventAt,
              lastEventAt,
              cliSessionId: csId,
              invocationId: invId,
              rawArchivePath,
            }),
          };
          yield {
            type: 'error',
            catId: this.catId,
            metadata,
            timestamp: Date.now(),
            error: `Kimi CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${firstEventAt == null ? ', 未收到首帧' : ''})`,
          };
          continue;
        }
        if (isLivenessWarning(event)) {
          const w = event as { level?: string; silenceDurationMs?: number };
          log.warn(
            { catId: this.catId, invocationId: options?.invocationId, level: w.level, silenceMs: w.silenceDurationMs },
            '[KimiAgent] liveness warning — CLI may be stuck',
          );
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            timestamp: Date.now(),
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
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

        if (
          event &&
          typeof event === 'object' &&
          'line' in event &&
          typeof (event as { line?: unknown }).line === 'string' &&
          !emittedSessionInit
        ) {
          const line = (event as { line: string }).line;
          const match = line.match(/To resume this session:\s*kimi\s+-r\s+([a-z0-9-]+)/i);
          if (match?.[1]) {
            metadata.sessionId = match[1];
            emittedSessionInit = true;
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId: match[1],
              metadata: { ...metadata, sessionId: match[1] },
              timestamp: Date.now(),
            };
          }
          continue;
        }

        const msg = event as KimiPrintMessage;
        if (msg?.role !== 'assistant') continue;

        const usage = parseUsage(msg.usage) ?? parseUsage(msg.stats);
        if (usage) metadata.usage = { ...(metadata.usage ?? {}), ...usage };

        const messageSessionId = readSessionIdFromMessage(msg);
        if (messageSessionId) {
          metadata.sessionId = messageSessionId;
          if (!emittedSessionInit) {
            emittedSessionInit = true;
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId: messageSessionId,
              metadata,
              timestamp: Date.now(),
            };
          }
        }

        const thinking = extractThinkingContent(msg);
        if (thinking) {
          sawThinking = true;
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thinking }),
            metadata,
            timestamp: Date.now(),
          };
        }

        if (imagePaths.length > 0 && !emittedImageCapability) {
          emittedImageCapability = true;
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({
              type: 'provider_capability',
              capability: 'image_input',
              status: supportsImageInput ? 'available' : 'limited',
              provider: 'kimi',
              reason: supportsImageInput
                ? '已通过工作区附加目录 + 本地路径提示向 kimi-cli 暴露图片输入'
                : '当前 Kimi 模型未声明 image_in，已回退为本地路径提示',
            }),
            metadata,
            timestamp: Date.now(),
          };
        }

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
            metadata: { ...metadata, sessionId: inferredSessionId },
            timestamp: Date.now(),
          };
        }
      }

      if (metadata.sessionId && modelConfig.maxContextSize != null) {
        try {
          const contextUsedTokens = await readKimiContextUsedTokens(metadata.sessionId, options?.callbackEnv);
          if (contextUsedTokens != null) {
            metadata.usage = {
              ...(metadata.usage ?? {}),
              contextUsedTokens,
              contextWindowSize: modelConfig.maxContextSize,
              lastTurnInputTokens: contextUsedTokens,
            };
          }
        } catch {
          // best-effort snapshot enrichment only
        }
      }

      if (!sawThinking) {
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({
            type: 'provider_capability',
            capability: 'thinking',
            status: 'unavailable',
            provider: 'kimi',
            reason: supportsThinking
              ? 'kimi-cli 本次流式输出未提供可解析的 think/reasoning 内容'
              : '当前 Kimi 模型能力未声明 thinking，已按普通回答处理',
          }),
          metadata,
          timestamp: Date.now(),
        };
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
    } finally {
      if (tempMcpConfig) {
        try {
          rmSync(dirname(tempMcpConfig), { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
}
