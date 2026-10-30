/** Kimi Code service — native identity channel and stream-json replies. */

import { readFileSync } from 'node:fs';
import {
  type CatId,
  type CliEffortPreset,
  catRegistry,
  createCatId,
  getCliEffortOptionsForProvider,
  resolveCliEffortOverride,
} from '@cat-cafe/shared';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { estimateCostFromTokens } from '../../../../../config/model-pricing.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { resolveKimiCliRuntime, resolveKimiRuntimePaths } from '../../../../../utils/kimi-cli-runtime.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  PreparedProviderRequestV1,
} from '../../types.js';
import { type FrozenRuntimeSelection, inheritedEffortFor } from '../invocation/runtime-selection.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractTrustedImagePaths } from './image-paths.js';
import {
  buildApiKeyEnv,
  readKimiConfiguredModel,
  readKimiContextUsedTokens,
  readKimiModelConfigInfo,
  readKimiSessionId,
  resolveKimiModelAlias,
  resolveKimiShareDir,
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
import { type KimiMcpLease, prepareKimiMcpConfig } from './kimi-mcp-config.js';
import { ensureKimiSecretHooks } from './kimi-secret-hooks.js';
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
  /** Admission snapshot; absent only for direct (non-queue) callers. */
  runtimeSelection?: FrozenRuntimeSelection,
): string | null {
  if (!getCliEffortOptionsForProvider('kimi', effectiveModel)) return null;
  const inherited = runtimeSelection
    ? inheritedEffortFor(runtimeSelection, 'kimi')
    : getCatEffort(catId, undefined, 'kimi', effectiveModel);
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
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly mcpServerPath: string | undefined;

  constructor(options?: KimiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('kimi');
    this.spawnFn = options?.spawnFn;
    this.mcpServerPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
  }

  /** Kimi Code carries identity through its native --agent-file channel. */
  injectsL0Natively(): boolean {
    return isKimiNativeL0ChannelAvailable();
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return {
      provider: 'kimi',
      carrier: 'kimi_stream_json',
      deliverySemantics: 'unsupported',
      activeInvocationGuidance: 'unsupported',
    };
  }

  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'kimi',
      carrier: 'stream_json',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: true,
      reason: 'Kimi session stats report current context usage and model window',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    // Match the native tool's path/config environment, including the selected
    // account's overrides. Identity and MCP callback authorization stay scoped
    // to callbackEnv; only path/model readers use this merged environment.
    const runtime = resolveKimiCliRuntime();
    const toolEnv = { ...options?.callbackEnv, ...options?.accountEnv };
    const runtimePaths = resolveKimiRuntimePaths(toolEnv);
    const requestedModel = options?.callbackEnv?.CAT_CAFE_KIMI_MODEL_OVERRIDE ?? this.model;
    // Empty native selection means omit --model and let the CLI resolve its own config.
    const followsNativeConfig = catRegistry.tryGet(this.catId)?.config.configurationSource === 'native_tool';
    const effectiveModel =
      requestedModel && !followsNativeConfig
        ? resolveKimiModelAlias(requestedModel, toolEnv, runtimePaths)
        : requestedModel;
    // P2-2: a native_tool member without an explicit model follows the local CLI
    // config. Observe the model that config selects so metadata, capability /
    // context-window reads and API-key env carry the real identity. The observed
    // value is evidence only — it is never injected as `--model`, because the
    // CLI owns the request identity for this member. Unreadable config stays
    // conservative: no model claim instead of a guessed alias.
    const observedModel =
      followsNativeConfig && !effectiveModel ? readKimiConfiguredModel(toolEnv, runtimePaths) : undefined;
    const identityModel = effectiveModel || observedModel || '';
    const effortLevel = resolveKimiEffortLevel(
      this.catId as string,
      identityModel,
      options?.reasoningEffortOverride,
      options?.runtimeSelection,
    );
    const metadata: MessageMetadata = { provider: 'kimi', model: identityModel };
    const imagePaths = await extractTrustedImagePaths(
      options?.contentBlocks,
      options?.uploadDir,
      options?.resolveTrustedImagePath,
    );
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    // Identity and pack travel through --agent-file; the user prompt stays unwrapped.
    const effectivePrompt = buildKimiPrompt(prompt, imagePaths);
    const workingDirectory = options?.workingDirectory ?? process.cwd();
    const kimiShareDir = resolveKimiShareDir(toolEnv, runtimePaths);
    const apiKeyEnv = buildApiKeyEnv(identityModel, options?.callbackEnv);
    const kimiCommand = runtime?.command;
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
    const modelConfig = readKimiModelConfigInfo(identityModel, toolEnv, runtimePaths);
    const supportsImageInput =
      modelConfig.capabilities.includes('image_in') ||
      apiKeyEnv?.KIMI_MODEL_CAPABILITIES?.includes('image_in') === true;

    // F203 Phase J: compile per-cat L0 → temp agent file for `--agent-file`.
    // fail-closed (mirrors Codex developer_instructions): a missing L0 = a cat
    // with no identity/家规, strictly worse than a failed invocation.
    //
    // F274 follow-up（愿景守护 Terra BLOCKED）: kimi-code freezes the agent
    // prompt at session first bind, so a blind `--session` resume silently
    // keeps the OLD L0. Compare the compiled-L0 fingerprint against the one
    // recorded at first bind; only an exact match resumes. stale / unknown
    // (unverifiable, incl. pre-F274 sessions) → fresh session + explicit
    // `l0_resume_fresh_start` notice.
    let l0AgentFilePath: string | undefined;
    let l0Fingerprint: string | undefined;
    let effectiveResumeSessionId: string | undefined;
    // Fresh-start 时被拒绝的旧 session id：之后任何 session 发现点都不得把
    // 新指纹记到它名下，也不得把它当作当前会话（防"记录后下次合法 resume
    // 旧会话"的回退漏洞 —— 愿景守护 Terra 护栏③）。
    let rejectedResumeSessionId: string | undefined;
    try {
      const l0 = await this.l0CompilerFn({
        catId: this.catId as string,
        userId: options?.callbackEnv?.CAT_CAFE_USER_ID,
        ...(options?.frozenL0Input ? { frozenInput: options.frozenL0Input } : {}),
      });
      l0Fingerprint = computeKimiL0Fingerprint(l0);
      let freshStartReason: 'stale' | 'unverifiable' | undefined;
      if (options?.sessionId) {
        const stored = lookupKimiL0Fingerprint(kimiShareDir, this.catId as string, options.sessionId);
        if (stored === l0Fingerprint) {
          effectiveResumeSessionId = options.sessionId;
        } else {
          if (options.requireExactResume)
            throw new Error(
              'Exact Kimi resume requires the original verified current identity; refusing a fresh session',
            );
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
      // kimi-code >=0.30 hard-rejects `--agent-file` alongside `--session`
      // ("the agent is bound at session creation and the bound agent is
      // restored automatically on resume") — exit 1 before any turn runs.
      // The flag only ever selected the agent for a *new* session, so on a
      // resume it was already a silent no-op; the fingerprint gate above has
      // just proven the bound agent IS this exact L0, so dropping the file
      // is the honest expression of the CLI's own semantics, not a downgrade.
      // The L0 stays compiled either way — the gate depends on it.
      if (!effectiveResumeSessionId) {
        l0AgentFilePath = writeKimiL0AgentFile(
          buildKimiL0AgentFileContent({
            catId: this.catId as string,
            l0,
            packSystemPrompt: freshStartReason
              ? (options?.resumeFallbackSystemPrompt ?? options?.systemPrompt)
              : options?.systemPrompt,
          }),
        );
      }
    } catch (err) {
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

    const args: string[] = ['--output-format', 'stream-json'];
    const managedArgvFlags: string[] = [];
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
    for (const dir of imageAccessDirs) args.push('--add-dir', dir);
    if (!apiKeyEnv && effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (l0AgentFilePath) {
      args.push('--agent-file', l0AgentFilePath);
      managedArgvFlags.push('--agent-file');
    }
    args.push('-p', effectivePrompt);

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

    let mcpLease: KimiMcpLease | undefined;
    try {
      await ensureKimiSecretHooks({ ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) });
      mcpLease = await prepareKimiMcpConfig({
        callbackEnv: { ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) },
        workingDirectory: options?.workingDirectory,
        mcpServerPath: this.mcpServerPath,
      });
      let emittedSessionInit = Boolean(effectiveResumeSessionId);
      let sawModelOutput = false;
      let emittedImageCapability = false;
      let hadCliError = false;
      // clowder-ai#1197 review (Terra P1): cost estimation is only allowed
      // from an immutable raw cost basis captured from usage/stats actually
      // emitted by THIS invocation — never from post-enrichment
      // metadata.usage (the session snapshot writes lastTurnInputTokens for
      // health display; it is not verified billable turn telemetry).
      let rawCostBasis: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
      const promptFlag = '-p';
      const promptIndex = args.lastIndexOf(promptFlag);
      const submittedPrompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
      if (typeof submittedPrompt !== 'string') throw new Error('kimi_request_prompt_unavailable');
      const nativeInstructions: PreparedProviderRequestV1['nativeInstructions'] = l0AgentFilePath
        ? [
            {
              body: readFileSync(l0AgentFilePath, 'utf8'),
              injectionDecision: 'native_agent_file_compiled',
            },
          ]
        : [];
      const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
        v: 1,
        message: Object.freeze({
          body: submittedPrompt,
          ...(submittedPrompt !== effectivePrompt ? { injectionDecision: 'member_cli_prompt_override' } : {}),
        }),
        nativeInstructions: Object.freeze(nativeInstructions.map((instruction) => Object.freeze(instruction))),
        runtime: Object.freeze({
          provider: 'kimi',
          carrier: 'stream_json',
          ...(identityModel ? { model: identityModel } : {}),
          protocol: 'stream-json',
          ...(effortLevel ? { reasoningEffort: effortLevel } : {}),
        }),
        tools: Object.freeze({ finalSurface: 'unknown' as const }),
        providerNativeVisibility: 'unknown',
      });
      await options?.beforeProviderLaunch?.(preparedRequest);
      if (!('body' in preparedRequest.message)) throw new Error('kimi_prepared_message_not_exact');
      args[promptIndex + 1] = preparedRequest.message.body;
      const cliOpts = {
        command: kimiCommand,
        args,
        ...(managedArgvFlags.length > 0 ? { managedArgvFlags } : {}),
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
          ...mcpLease.env,
          KIMI_MODEL_THINKING_EFFORT: effortLevel,
          // Native mode requires the kimi-code v2 engine for --agent-file.
          [KIMI_V2_ENGINE_ENV_KEY]: '1',
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
            if (l0Fingerprint) {
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

        if (!(msg?.role === 'assistant' || msg?.role === 'meta')) continue;

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
            if (l0Fingerprint && metaMsg.session_id !== rejectedResumeSessionId) {
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
        if (usage) {
          metadata.usage = { ...(metadata.usage ?? {}), ...usage };
          // Capture the raw billable fields BEFORE any snapshot enrichment
          // can touch metadata.usage. Latest non-null value per field wins,
          // mirroring the merge semantics above.
          rawCostBasis = {
            inputTokens: usage.inputTokens ?? usage.lastTurnInputTokens ?? rawCostBasis?.inputTokens,
            outputTokens: usage.outputTokens ?? rawCostBasis?.outputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? rawCostBasis?.cacheReadTokens,
          };
        }

        const messageSessionId = readSessionIdFromMessage(msg);
        if (messageSessionId && messageSessionId !== rejectedResumeSessionId) {
          metadata.sessionId = messageSessionId;
          if (!emittedSessionInit) {
            emittedSessionInit = true;
            if (l0Fingerprint && messageSessionId !== rejectedResumeSessionId) {
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

        const thinking = extractThinkingContent(msg);
        if (thinking) {
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
                ? '已通过工作区附加目录 + 本地路径提示向 Kimi Code 暴露图片输入'
                : '当前 Kimi 模型未声明 image_in，已回退为本地路径提示',
            }),
            metadata,
            timestamp: Date.now(),
          };
        }

        const content = extractTextContent(msg.content);
        if (content) {
          if (content.trim()) sawModelOutput = true;
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
          sawModelOutput = true;
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
        const inferredSessionId = readKimiSessionId(workingDirectory, toolEnv, runtimePaths);
        if (inferredSessionId && inferredSessionId !== rejectedResumeSessionId) {
          metadata.sessionId = inferredSessionId;
          emittedSessionInit = true;
          if (l0Fingerprint && inferredSessionId !== rejectedResumeSessionId) {
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
          const contextUsedTokens = await readKimiContextUsedTokens(metadata.sessionId, toolEnv, runtimePaths);
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

      // clowder-ai#1197: Kimi CLI never reports costUsd. Estimate an
      // API-equivalent cost from the pricing table (same pattern as Codex).
      // Keyed by identityModel (= metadata.model, what the client actually
      // reports or the native config selects); unknown aliases return null and
      // stay unpriced — token telemetry still shows, no guessing.
      //
      // Review gates (Terra, cat-cafe#3479):
      //   1. Estimate only from the immutable raw cost basis captured above,
      //      and only when that raw record itself carries billable fields
      //      (input or last-turn input, plus output). stats carrying only
      //      total/context tokens do NOT qualify, and the post-enrichment
      //      snapshot lastTurnInputTokens is never read for cost.
      //   2. Skip estimation when the raw record reports cached input:
      //      whether Kimi's cached_input_tokens is a subset of input_tokens
      //      (OpenAI-shaped) is NOT documented by any official schema and we
      //      hold no verified live sample. Until one is captured, cache-split
      //      arithmetic would rest on an unproven input contract — omit cost.
      const rawInput = rawCostBasis?.inputTokens;
      const rawOutput = rawCostBasis?.outputTokens;
      const rawCachedInput = rawCostBasis?.cacheReadTokens ?? 0;
      if (
        rawInput != null &&
        rawOutput != null &&
        rawCachedInput === 0 &&
        metadata.usage &&
        metadata.usage.costUsd == null
      ) {
        const estimatedCost = estimateCostFromTokens(identityModel, rawInput, rawOutput);
        if (estimatedCost != null) {
          metadata.usage.costUsd = estimatedCost;
          metadata.usage.costEstimated = true;
        }
      }

      if (!sawModelOutput && !hadCliError) {
        yield {
          type: 'error',
          catId: this.catId,
          error: 'Kimi Code 未返回可解析的回复或工具调用。请确认安装的是新版 Kimi Code（kimi），并检查执行记录。',
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
      removeKimiL0AgentFileDir(l0AgentFilePath);
      await mcpLease?.dispose();
    }
  }
}
