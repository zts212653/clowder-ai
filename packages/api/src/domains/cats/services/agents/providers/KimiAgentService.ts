/** Kimi Agent Service — kimi-cli subprocess via print mode + stream-json. */

import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CatId,
  type CliEffortPreset,
  createCatId,
  getCliEffortOptionsForProvider,
  resolveCliEffortOverride,
} from '@cat-cafe/shared';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
} from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { resolveDefaultClaudeMcpServerPath } from './ClaudeAgentService.js';
import { collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import {
  buildApiKeyEnv,
  readKimiContextUsedTokens,
  readKimiModelConfigInfo,
  readKimiSessionId,
  resolveKimiModelAlias,
  resolveKimiShareDir,
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
import {
  buildKimiL0AgentFileContent,
  isKimiNativeL0ChannelAvailable,
  KIMI_V2_ENGINE_ENV_KEY,
  removeKimiL0AgentFileDir,
  stripReservedKimiSystemArgs,
  writeKimiL0AgentFile,
} from './kimi-l0-agent-file.js';
import {
  computeKimiL0Fingerprint,
  lookupKimiL0Fingerprint,
  recordKimiL0Fingerprint,
} from './kimi-l0-session-fingerprint.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('kimi-agent');

/**
 * Resolve the invocation effort once for every Kimi carrier.
 * Passed to kimi-code via the KIMI_MODEL_THINKING_EFFORT env override (the
 * CLI's operational effort channel; bypasses support_efforts but cannot
 * re-enable thinking the user turned off).
 *
 * Returns null for boolean-thinking Kimi models (no support_efforts metadata,
 * e.g. kimi-for-coding): the harness must not invent tiers the model does not
 * have, so the CLI keeps its own thinking config and no env is injected.
 */
export function resolveKimiEffortLevel(
  catId: string,
  effectiveModel: string | null | undefined,
  override: CliEffortPreset | null | undefined,
): string | null {
  if (!getCliEffortOptionsForProvider('kimi', effectiveModel)) return null;
  const inherited = getCatEffort(catId, undefined, 'kimi', effectiveModel);
  return resolveCliEffortOverride('kimi', effectiveModel, inherited, override).effective;
}

interface KimiAgentServiceOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  mcpServerPath?: string;
  /** #780: Raw NDJSON archive sink (default: CliRawArchive to disk) */
  rawArchive?: RawArchiveSink;
  /** F203 Phase J: L0 compile seam for the native --agent-file channel (test injection). */
  l0CompilerFn?: typeof compileL0ViaSubprocess;
}

export class KimiAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly mcpServerPath: string | undefined;
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;

  constructor(options?: KimiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('kimi');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.mcpServerPath =
      options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH ?? resolveDefaultClaudeMcpServerPath();
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
  }

  /**
   * F203 Phase J — the new kimi-code CLI injects L0 natively via
   * `--agent-file` (system role, compression-immune). The legacy `kimi-cli`
   * has no native channel, so when it is the resolvable binary we keep the
   * user-prompt `<system_instructions>` prepend and report false here.
   */
  injectsL0Natively(): boolean {
    return isKimiNativeL0ChannelAvailable();
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return { provider: 'kimi', carrier: 'kimi_stream_json', deliverySemantics: 'unsupported' };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const requestedModel = options?.callbackEnv?.CAT_CAFE_KIMI_MODEL_OVERRIDE ?? this.model;
    const effectiveModel = resolveKimiModelAlias(requestedModel, options?.callbackEnv);
    const effortLevel = resolveKimiEffortLevel(this.catId as string, effectiveModel, options?.reasoningEffortOverride);
    const metadata: MessageMetadata = { provider: 'kimi', model: effectiveModel };
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    const isLegacy = resolveCliCommand('kimi-cli') !== null;
    // Native mode (new kimi-code): identity + pack travel the `--agent-file`
    // system-prompt channel, so the user prompt stays unwrapped. Legacy
    // kimi-cli keeps the `<system_instructions>` prepend.
    const effectivePrompt = buildKimiPrompt(prompt, isLegacy ? options?.systemPrompt : undefined, imagePaths);
    const workingDirectory = options?.workingDirectory ?? process.cwd();
    const kimiShareDir = resolveKimiShareDir(options?.callbackEnv);
    const apiKeyEnv = buildApiKeyEnv(effectiveModel, options?.callbackEnv);
    const kimiCommand = resolveCliCommand('kimi-cli') ?? resolveCliCommand('kimi');
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
    // Lazy create tempMcpConfig only AFTER we know kimi binary exists. If we created it
    // before the not-found early-return (kimi/kimi-cli both absent + mcpServerPath set),
    // the temp dir would leak — finally cleanup (line ~440) is gated by the try block below
    // and the early-return jumps over it. Source clowder-ai#944 has the same regression.
    const tempMcpConfig = this.mcpServerPath
      ? await writeMcpConfigFile(workingDirectory, this.mcpServerPath, options?.callbackEnv)
      : null;
    const modelConfig = readKimiModelConfigInfo(effectiveModel, options?.callbackEnv);
    const supportsThinking =
      modelConfig.capabilities.includes('thinking') ||
      apiKeyEnv?.KIMI_MODEL_CAPABILITIES?.includes('thinking') === true;
    const supportsImageInput =
      modelConfig.capabilities.includes('image_in') ||
      apiKeyEnv?.KIMI_MODEL_CAPABILITIES?.includes('image_in') === true;

    const cliSupportsThinking = isLegacy && (supportsThinking || modelConfig.defaultThinking);

    // F203 Phase J: compile per-cat L0 → temp agent file for `--agent-file`.
    // fail-closed (mirrors Codex developer_instructions): a missing L0 = a cat
    // with no identity/家规, strictly worse than a failed invocation. Any
    // tempMcpConfig dir created above is cleaned up before returning.
    //
    // F274 follow-up（愿景守护 Terra BLOCKED）: kimi-code freezes the agent
    // prompt at session first bind, so a blind `--session` resume silently
    // keeps the OLD L0. Compare the compiled-L0 fingerprint against the one
    // recorded at first bind; only an exact match resumes. stale / unknown
    // (unverifiable, incl. pre-F274 sessions) → fresh session + explicit
    // `l0_resume_fresh_start` notice. Legacy path is untouched.
    let l0AgentFilePath: string | undefined;
    let l0Fingerprint: string | undefined;
    let effectiveResumeSessionId = isLegacy ? options?.sessionId : undefined;
    // Fresh-start 时被拒绝的旧 session id：之后任何 session 发现点都不得把
    // 新指纹记到它名下，也不得把它当作当前会话（防"记录后下次合法 resume
    // 旧会话"的回退漏洞 —— 愿景守护 Terra 护栏③）。
    let rejectedResumeSessionId: string | undefined;
    if (!isLegacy) {
      try {
        const l0 = await this.l0CompilerFn({
          catId: this.catId as string,
          userId: options?.callbackEnv?.CAT_CAFE_USER_ID,
        });
        l0Fingerprint = computeKimiL0Fingerprint(l0);
        let freshStartReason: 'stale' | 'unverifiable' | undefined;
        if (options?.sessionId) {
          const stored = lookupKimiL0Fingerprint(kimiShareDir, this.catId as string, options.sessionId);
          if (stored === l0Fingerprint) {
            effectiveResumeSessionId = options.sessionId;
          } else {
            freshStartReason = stored === undefined ? 'unverifiable' : 'stale';
            rejectedResumeSessionId = options.sessionId;
          }
        }
        if (freshStartReason) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({
              type: 'l0_resume_fresh_start',
              reason: freshStartReason,
              previousSessionId: options?.sessionId,
              detail:
                'kimi-code 在 session 首 bind 冻结 agent prompt；检测到 L0 漂移/不可验证，改用 fresh session 绑定新 L0，旧会话上下文不再延续',
            }),
            metadata,
            timestamp: Date.now(),
          };
        }
        l0AgentFilePath = writeKimiL0AgentFile(
          buildKimiL0AgentFileContent({
            catId: this.catId as string,
            l0,
            packSystemPrompt: freshStartReason
              ? (options?.resumeFallbackSystemPrompt ?? options?.systemPrompt)
              : options?.systemPrompt,
          }),
        );
      } catch (err) {
        if (tempMcpConfig) {
          try {
            rmSync(dirname(tempMcpConfig), { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: `L0 compile failed for ${this.catId as string}: ${message}`,
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
    }

    const args: string[] = isLegacy
      ? ['--print', '--output-format', 'stream-json']
      : ['--output-format', 'stream-json'];
    if (effectiveResumeSessionId) {
      args.push('--session', effectiveResumeSessionId);
      metadata.sessionId = effectiveResumeSessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: effectiveResumeSessionId,
        metadata,
        timestamp: Date.now(),
      };
    }
    if (isLegacy) {
      args.push('--work-dir', workingDirectory);
      if (cliSupportsThinking) {
        args.push('--thinking');
      }
      if (tempMcpConfig) {
        args.push('--mcp-config-file', tempMcpConfig);
      }
      for (const dir of imageAccessDirs) {
        args.push('--add-dir', dir);
      }
    }
    if (!apiKeyEnv && effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (l0AgentFilePath) {
      args.push('--agent-file', l0AgentFilePath);
    }
    if (isLegacy) {
      args.push('--prompt', effectivePrompt);
    } else {
      args.push('-p', effectivePrompt);
    }

    // User-defined CLI args from the member editor (#567).
    // `--agent-file` / `--agent` are reserved (they carry the compression-immune
    // L0) and stripped from user parts before the dedup pass.
    const userParts: string[] = stripReservedKimiSystemArgs(
      options?.cliConfigArgs?.flatMap((arg) => arg.trim().split(/\s+/)) ?? [],
    );
    if (userParts.length > 0) {
      const accumulativeFlags = new Set(['--add-dir']);
      const userFlags = new Set(userParts.filter((p) => p.startsWith('-')));
      const deduped: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-') && userFlags.has(args[i]) && !accumulativeFlags.has(args[i])) {
          if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
          continue;
        }
        deduped.push(args[i]);
      }
      args.length = 0;
      args.push(...deduped, ...userParts);
    }

    try {
      let emittedSessionInit = Boolean(effectiveResumeSessionId);
      let sawThinking = false;
      let emittedImageCapability = false;
      let hadCliError = false;
      const cliOpts = {
        command: kimiCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        // env is always present: KIMI_MODEL_THINKING_EFFORT carries the resolved
        // member/thread effort for tier-capable models. For boolean-thinking
        // models (effortLevel === null) the explicit null is a deletion marker:
        // buildChildEnv removes any parent/callback/account value so the CLI
        // keeps its own thinking config (the var is a force-on-wire channel
        // that bypasses support_efforts, not a harmless leftover).
        // Configured effort wins over account/callback env.
        env: {
          ...(options?.callbackEnv ?? {}),
          ...(apiKeyEnv ?? {}),
          ...(options?.accountEnv ?? {}),
          KIMI_MODEL_THINKING_EFFORT: effortLevel,
          // Native mode requires the kimi-code v2 engine for --agent-file.
          ...(!isLegacy ? { [KIMI_V2_ENGINE_ENV_KEY]: '1' } : {}),
        },
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      for await (const event of events) {
        // #780: Archive raw event for post-mortem diagnostics (fire-and-forget)
        if (options?.invocationId) {
          this.rawArchive.append(options.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn({ catId: this.catId, invocationId: options.invocationId, err }, 'Raw archive write failed');
          });
        }
        if (isCliTimeout(event)) {
          hadCliError = true;
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
              terminalContext: event.terminalContext,
            }),
          };
          yield {
            type: 'error',
            catId: this.catId,
            // F212 Phase A (云端 codex P2): timeout cliDiagnostics 也透传到 metadata.
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
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
          hadCliError = true;
          // F212 Phase A: forward cliDiagnostics on metadata for frontend folded panel (Phase B).
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Kimi CLI', event),
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
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
          // 第四发现点（Terra P2 复审）：非 JSON resume hint 同样不得让被拒 id
          // 占槽/发布/落盘——native fresh-start 下这条 line 可能就是 sess-old。
          if (match?.[1] && match[1] !== rejectedResumeSessionId) {
            metadata.sessionId = match[1];
            emittedSessionInit = true;
            // 与 meta/assistant/kimi.json 三个发现点同契约：有效新 id 既然
            // 信任到足以发布 session_init，就必须落盘指纹——否则下次 resume
            // 必为 unverifiable，持续 fresh-start 丢连续性（Terra P2 第三轮）。
            if (!isLegacy && l0Fingerprint) {
              recordKimiL0Fingerprint(kimiShareDir, this.catId as string, match[1], l0Fingerprint);
            }
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

        if (isLegacy ? msg?.role !== 'assistant' : !(msg?.role === 'assistant' || msg?.role === 'meta')) continue;

        if (msg?.role === 'meta') {
          const metaMsg = msg as { role: string; type?: string; session_id?: string; content?: string };
          if (
            metaMsg.type === 'session.resume_hint' &&
            metaMsg.session_id &&
            metaMsg.session_id !== rejectedResumeSessionId &&
            !emittedSessionInit
          ) {
            metadata.sessionId = metaMsg.session_id;
            emittedSessionInit = true;
            if (!isLegacy && l0Fingerprint && metaMsg.session_id !== rejectedResumeSessionId) {
              recordKimiL0Fingerprint(kimiShareDir, this.catId as string, metaMsg.session_id, l0Fingerprint);
            }
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId: metaMsg.session_id,
              metadata: { ...metadata, sessionId: metaMsg.session_id },
              timestamp: Date.now(),
            };
          }
          continue;
        }

        const usage = parseUsage(msg.usage) ?? parseUsage(msg.stats);
        if (usage) metadata.usage = { ...(metadata.usage ?? {}), ...usage };

        const messageSessionId = readSessionIdFromMessage(msg);
        if (messageSessionId && messageSessionId !== rejectedResumeSessionId) {
          metadata.sessionId = messageSessionId;
          if (!emittedSessionInit) {
            emittedSessionInit = true;
            if (!isLegacy && l0Fingerprint && messageSessionId !== rejectedResumeSessionId) {
              recordKimiL0Fingerprint(kimiShareDir, this.catId as string, messageSessionId, l0Fingerprint);
            }
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId: messageSessionId,
              metadata,
              timestamp: Date.now(),
            };
          }
        }

        if (isLegacy) {
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
        if (inferredSessionId && inferredSessionId !== rejectedResumeSessionId) {
          metadata.sessionId = inferredSessionId;
          emittedSessionInit = true;
          if (!isLegacy && l0Fingerprint && inferredSessionId !== rejectedResumeSessionId) {
            recordKimiL0Fingerprint(kimiShareDir, this.catId as string, inferredSessionId, l0Fingerprint);
          }
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

      if (isLegacy && !sawThinking && !hadCliError) {
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
      removeKimiL0AgentFileDir(l0AgentFilePath);
    }
  }
}
