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

import {
  existsSync,
  promises as fs,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';
import { resolveDefaultClaudeMcpServerPath } from './ClaudeAgentService.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';

const log = createModuleLogger('kimi-agent');
const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_KIMI_MODEL_ALIAS = 'kimi-code/kimi-for-coding';
const CAT_CAFE_CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_SIGNAL_USER',
] as const;

interface KimiAgentServiceOptions {
  catId?: CatId;
  model?: string;
  spawnFn?: SpawnFn;
  mcpServerPath?: string;
}

interface KimiPrintMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  thought?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  usage?: unknown;
  stats?: unknown;
}

interface KimiModelConfigInfo {
  readonly defaultThinking: boolean;
  readonly capabilities: readonly string[];
  readonly maxContextSize?: number;
}

const KIMI_CONTEXT_TAIL_BYTES = 64 * 1024;

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

function extractThinkingContent(message: KimiPrintMessage): string | null {
  const candidates = [message.thinking, message.reasoning, message.reasoning_content, message.thought];
  for (const candidate of candidates) {
    const text = extractTextContent(candidate);
    if (text) return text;
  }
  if (Array.isArray(message.content)) {
    const thinkText = message.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        if (typeof block.think === 'string') return block.think;
        if (typeof block.reasoning === 'string') return block.reasoning;
        if (block.type === 'thinking' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (thinkText) return thinkText;
  }
  return null;
}

function parseUsage(candidate: unknown): TokenUsage | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const stats = candidate as Record<string, unknown>;
  const usage = {} as TokenUsage;
  if (typeof stats.total_tokens === 'number') usage.totalTokens = stats.total_tokens;
  if (typeof stats.input_tokens === 'number') usage.inputTokens = stats.input_tokens;
  if (typeof stats.output_tokens === 'number') usage.outputTokens = stats.output_tokens;
  if (typeof stats.cached_input_tokens === 'number') usage.cacheReadTokens = stats.cached_input_tokens;
  if (typeof stats.last_turn_input_tokens === 'number') usage.lastTurnInputTokens = stats.last_turn_input_tokens;
  if (typeof stats.context_window === 'number') usage.contextWindowSize = stats.context_window;
  if (typeof stats.context_used_tokens === 'number') usage.contextUsedTokens = stats.context_used_tokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

function readSessionIdFromMessage(message: KimiPrintMessage): string | undefined {
  const values = [message.session_id, message.sessionId];
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function buildKimiPrompt(prompt: string, systemPrompt?: string, imagePaths: readonly string[] = []): string {
  const basePrompt = appendLocalImagePathHints(prompt, imagePaths);
  if (!systemPrompt?.trim()) return basePrompt;
  return [
    '<system_instructions>',
    systemPrompt.trim(),
    '</system_instructions>',
    '',
    '<user_request>',
    basePrompt,
    '</user_request>',
  ].join('\n');
}

function resolveKimiShareDir(callbackEnv?: Record<string, string>): string {
  return callbackEnv?.KIMI_SHARE_DIR || process.env.KIMI_SHARE_DIR || resolve(homedir(), '.kimi');
}

function resolveKimiConfigPath(callbackEnv?: Record<string, string>): string {
  const explicit = callbackEnv?.KIMI_CONFIG_FILE || process.env.KIMI_CONFIG_FILE;
  if (explicit) return resolve(explicit);
  return join(resolveKimiShareDir(callbackEnv), 'config.toml');
}

function normalizeKimiWorkDirPath(candidate: string): string {
  const resolved = resolve(candidate);
  try {
    return normalize(realpathSync(resolved));
  } catch {
    return normalize(resolved);
  }
}

function readKimiModelConfigInfo(modelAlias: string, callbackEnv?: Record<string, string>): KimiModelConfigInfo {
  const fallbackCapabilities: string[] =
    modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? ['thinking', 'image_in', 'video_in'] : [];
  const configPath = resolveKimiConfigPath(callbackEnv);
  if (!existsSync(configPath)) {
    return {
      defaultThinking: fallbackCapabilities.includes('thinking'),
      capabilities: [...fallbackCapabilities],
      ...(modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? { maxContextSize: 262_144 } : {}),
    };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const defaultThinkingMatch = raw.match(/^\s*default_thinking\s*=\s*(true|false)\s*$/m);
    const sectionHeader = `[models."${modelAlias}"]`;
    const sectionStart = raw.indexOf(sectionHeader);
    let capabilities: string[] = [...fallbackCapabilities];
    let maxContextSize: number | undefined = modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? 262_144 : undefined;
    if (sectionStart >= 0) {
      const nextSection = raw.indexOf('\n[', sectionStart + sectionHeader.length);
      const section = raw.slice(sectionStart, nextSection >= 0 ? nextSection : undefined);
      const capsMatch = section.match(/^\s*capabilities\s*=\s*\[([^\]]*)\]/m);
      const maxContextMatch = section.match(/^\s*max_context_size\s*=\s*(\d+)\s*$/m);
      if (capsMatch?.[1]) {
        capabilities = Array.from(
          new Set(
            capsMatch[1]
              .split(',')
              .map((item) => item.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean),
          ),
        );
      }
      if (maxContextMatch?.[1]) {
        const parsed = Number.parseInt(maxContextMatch[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) maxContextSize = parsed;
      }
    }
    return {
      defaultThinking:
        defaultThinkingMatch?.[1] === 'true' ||
        capabilities.includes('thinking') ||
        fallbackCapabilities.includes('thinking'),
      capabilities,
      ...(maxContextSize ? { maxContextSize } : {}),
    };
  } catch {
    return {
      defaultThinking: fallbackCapabilities.includes('thinking'),
      capabilities: [...fallbackCapabilities],
      ...(modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? { maxContextSize: 262_144 } : {}),
    };
  }
}

function resolveKimiModelAlias(model: string, callbackEnv?: Record<string, string>): string {
  if (callbackEnv?.CAT_CAFE_KIMI_API_KEY) return model;
  if (model.includes('/')) return model;

  const configPath = resolveKimiConfigPath(callbackEnv);
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const match = raw.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m);
      if (match?.[1]) return match[1].trim();
    } catch {
      // Fall through to baked-in alias.
    }
  }

  return DEFAULT_KIMI_MODEL_ALIAS;
}

function readKimiSessionId(workingDirectory: string, callbackEnv?: Record<string, string>): string | undefined {
  const shareDir = resolveKimiShareDir(callbackEnv);
  const statePath = join(shareDir, 'kimi.json');
  if (!existsSync(statePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { work_dirs?: Array<Record<string, unknown>> };
    const workDirs = Array.isArray(raw?.work_dirs) ? raw.work_dirs : [];
    const target = normalizeKimiWorkDirPath(workingDirectory);
    const entry = workDirs.find(
      (item) => typeof item.path === 'string' && normalizeKimiWorkDirPath(item.path) === target,
    );
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

async function readTailUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const readBytes = Math.min(stat.size, maxBytes);
    if (readBytes <= 0) return '';
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, stat.size - readBytes);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function findKimiSessionContextFile(shareDir: string, sessionId: string): Promise<string | null> {
  const sessionsRoot = join(shareDir, 'sessions');
  const stack: string[] = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === sessionId) {
          const contextFile = join(abs, 'context.jsonl');
          try {
            await fs.access(contextFile);
            return contextFile;
          } catch {
            return null;
          }
        }
        stack.push(abs);
      }
    }
  }
  return null;
}

async function readKimiContextUsedTokens(
  sessionId: string,
  callbackEnv?: Record<string, string>,
): Promise<number | undefined> {
  const contextFile = await findKimiSessionContextFile(resolveKimiShareDir(callbackEnv), sessionId);
  if (!contextFile) return undefined;
  const tail = await readTailUtf8(contextFile, KIMI_CONTEXT_TAIL_BYTES);
  if (!tail) return undefined;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.role === '_usage' && typeof parsed.token_count === 'number' && Number.isFinite(parsed.token_count)) {
        return parsed.token_count;
      }
    } catch {}
  }
  return undefined;
}

function buildApiKeyEnv(model: string, callbackEnv?: Record<string, string>): Record<string, string> | null {
  const apiKey = callbackEnv?.CAT_CAFE_KIMI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = callbackEnv?.CAT_CAFE_KIMI_BASE_URL || DEFAULT_KIMI_BASE_URL;
  const configuredModelName = model.trim();
  return {
    KIMI_API_KEY: apiKey,
    KIMI_BASE_URL: baseUrl,
    KIMI_MODEL_NAME: configuredModelName,
    KIMI_MODEL_MAX_CONTEXT_SIZE: callbackEnv?.KIMI_MODEL_MAX_CONTEXT_SIZE || '262144',
    ...(callbackEnv?.KIMI_MODEL_CAPABILITIES ? { KIMI_MODEL_CAPABILITIES: callbackEnv.KIMI_MODEL_CAPABILITIES } : {}),
  };
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
    const tempMcpConfig = this.writeMcpConfigFile(workingDirectory, options?.callbackEnv);
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

  private writeMcpConfigFile(workingDirectory: string, callbackEnv?: Record<string, string>): string | null {
    if (!callbackEnv || !this.mcpServerPath) return null;
    const existingPath = join(workingDirectory, '.kimi', 'mcp.json');
    let config: Record<string, unknown> = {};
    if (existsSync(existingPath)) {
      try {
        const raw = JSON.parse(readFileSync(existingPath, 'utf-8')) as Record<string, unknown>;
        config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch {
        config = {};
      }
    }
    const currentServers =
      config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
        ? { ...(config.mcpServers as Record<string, unknown>) }
        : {};
    const catCafeEnv = Object.fromEntries(
      CAT_CAFE_CALLBACK_ENV_KEYS.map((key) => [key, callbackEnv[key]]).filter(([, value]) => Boolean(value)),
    );
    currentServers['cat-cafe'] = {
      command: 'node',
      args: [this.mcpServerPath],
      ...(Object.keys(catCafeEnv).length > 0 ? { env: catCafeEnv } : {}),
    };
    const nextConfig = { ...config, mcpServers: currentServers };
    const shareDir = resolveKimiShareDir(callbackEnv);
    mkdirSync(shareDir, { recursive: true });
    const dir = mkdtempSync(join(shareDir, 'tmp-mcp-'));
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify(nextConfig), { encoding: 'utf8', mode: 0o600 });
    return path;
  }
}
