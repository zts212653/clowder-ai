/**
 * Gemini Agent Service
 * 使用 Gemini CLI 子进程调用暹罗猫 (Gemini)
 *
 * 双 Adapter 架构:
 *   antigravity-cli (默认): spawn 'agy' CLI + plain stdout → 全自动 headless
 *   gemini-cli (fallback):  spawn 'gemini' CLI + NDJSON → legacy/enterprise fallback
 *   antigravity (legacy opt-in): spawn Antigravity IDE → MCP 回传 → 半自动
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
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { type AgyProfileConfig, type CatId, type CliDiagnostics, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics, buildSilentCompletionDiagnostic } from '../../../../../utils/cli-diagnostics.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import {
  buildChildEnv,
  isCliError,
  isCliPlainTextResult,
  isCliTimeout,
  isLivenessWarning,
  spawnCli,
} from '../../../../../utils/cli-spawn.js';
import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { readJsonlTail } from '../../../../../utils/jsonl-tail-reader.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from '../providers/image-cli-bridge.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { type AgyProfile, preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from './agy-profile-manager.js';
import { extractAgyFinalTextFromSteps, parseAgyStepTools, readAgyTrajectorySteps } from './agy-trajectory-extractor.js';
import {
  type AgyProgressEvent,
  createAgyResumeBaselineCursorResolver,
  listAgyConversationDbs,
  locateAgyTrajectoryDb,
  observeAgyProgress,
  readAgyDbFileIdentity,
  readAgyMaxStepIdx,
  readAgyStepsPrefixFingerprint,
  resolveAgyAppDataDir,
} from './agy-trajectory-observer.js';
import {
  classifyAntigravityCliPlainText,
  extractAntigravityCliConversationId,
  extractAntigravityCliSelectedModelLabel,
} from './antigravity-cli-event-parser.js';
import { isKnownPostResponseCandidatesCrash, isResultErrorEvent, transformGeminiEvent } from './gemini-event-parser.js';

const log = createModuleLogger('gemini-agent');

type GeminiAdapter = 'gemini-cli' | 'antigravity-cli' | 'antigravity';
const DEFAULT_GEMINI_ADAPTER: GeminiAdapter = 'antigravity-cli';

function resolveDiagnosticInvocationId(options: AgentServiceOptions | undefined): string | undefined {
  return options?.invocationId ?? options?.auditContext?.invocationId;
}

interface GeminiStoredThought {
  readonly subject?: string;
  readonly description?: string;
}

interface GeminiStoredTokenStats {
  readonly total?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cached?: number;
  readonly thoughts?: number;
  readonly tool?: number;
}

interface GeminiStoredMessage {
  readonly type?: string;
  readonly content?: string;
  readonly thoughts?: readonly GeminiStoredThought[];
  readonly tokens?: GeminiStoredTokenStats;
}

interface GeminiStoredSession {
  readonly sessionId?: string;
  readonly messages?: readonly GeminiStoredMessage[];
}

function normalizeGeminiContent(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, '');
}

function matchesCurrentAssistantText(messageContent: string | undefined, normalizedAssistantText: string): boolean {
  if (typeof messageContent !== 'string') return false;
  const normalizedMessageContent = normalizeGeminiContent(messageContent);
  if (normalizedMessageContent.length === 0) return false;
  return (
    normalizedMessageContent === normalizedAssistantText || normalizedAssistantText.endsWith(normalizedMessageContent)
  );
}

function formatGeminiThoughts(thoughts: readonly GeminiStoredThought[]): string {
  return thoughts
    .map((thought) => {
      const subject = thought.subject?.trim();
      const description = thought.description?.trim();
      if (subject && description) return `**${subject}**\n${description}`;
      if (subject) return `**${subject}**`;
      if (description) return description;
      return '';
    })
    .filter((chunk) => chunk.length > 0)
    .join('\n\n---\n\n');
}

function readGeminiThinkingFromLocalSession(
  sessionId: string | undefined,
  assistantText: string,
  workingDirectory?: string,
): string | null {
  const location = findGeminiSessionFile(sessionId, workingDirectory);
  if (!location) return null;

  const normalizedAssistantText = normalizeGeminiContent(assistantText);
  const matchesThoughts = (parsed: unknown): boolean => {
    if (parsed == null || typeof parsed !== 'object') return false;
    const message = parsed as GeminiStoredMessage;
    if (message.type !== 'gemini') return false;
    if (!Array.isArray(message.thoughts) || message.thoughts.length === 0) return false;
    if (typeof message.content !== 'string') return false;
    if (normalizedAssistantText.length === 0) return true;
    return matchesCurrentAssistantText(message.content, normalizedAssistantText);
  };

  if (location.ext === '.jsonl') {
    const match = readJsonlTail<GeminiStoredMessage>(location.path, { predicate: matchesThoughts });
    return match ? formatGeminiThoughts(match.thoughts ?? []) || null : null;
  }

  const parsed = parseGeminiSessionFile(location.path, '.json');
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const candidates = messages.filter(
    (message): message is GeminiStoredMessage =>
      message?.type === 'gemini' &&
      Array.isArray(message.thoughts) &&
      message.thoughts.length > 0 &&
      typeof message.content === 'string',
  );
  if (candidates.length === 0) return null;

  const exact =
    normalizedAssistantText.length > 0
      ? [...candidates]
          .reverse()
          .find((message) => matchesCurrentAssistantText(message.content, normalizedAssistantText))
      : candidates[candidates.length - 1];
  return exact ? formatGeminiThoughts(exact.thoughts ?? []) || null : null;
}

function parseGeminiSessionFile(filePath: string, ext: '.json' | '.jsonl'): GeminiStoredSession {
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (ext === '.json') {
      return JSON.parse(raw) as GeminiStoredSession;
    }

    let sessionId: string | undefined;
    const messages: GeminiStoredMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.sessionId === 'string' && typeof obj.type === 'undefined') {
          sessionId = sessionId ?? obj.sessionId;
          continue;
        }
        if (Object.hasOwn(obj, '$set')) continue;
        if (typeof obj.type === 'string') {
          messages.push(obj as unknown as GeminiStoredMessage);
        }
      } catch {
        // Best effort: skip malformed/partial lines while Gemini is still writing.
      }
    }
    return { sessionId, messages };
  } catch {
    return { messages: [] };
  }
}

interface GeminiSessionFileLocation {
  readonly path: string;
  readonly ext: '.json' | '.jsonl';
}

const JSONL_HEADER_MAX_BYTES = 1024;

function readJsonlHeaderSessionId(filePath: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const buffer = Buffer.alloc(JSONL_HEADER_MAX_BYTES);
    const n = readSync(fd, buffer, 0, JSONL_HEADER_MAX_BYTES, 0);
    if (n === 0) return undefined;
    const text = buffer.toString('utf8', 0, n);
    const newlineIdx = text.indexOf('\n');
    if (newlineIdx === -1) return undefined;
    try {
      const parsed = JSON.parse(text.substring(0, newlineIdx)) as { sessionId?: unknown; type?: unknown };
      if (typeof parsed.sessionId === 'string' && typeof parsed.type === 'undefined') {
        return parsed.sessionId;
      }
    } catch {
      return undefined;
    }
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

function findGeminiSessionFile(
  sessionId: string | undefined,
  workingDirectory?: string,
): GeminiSessionFileLocation | undefined {
  if (!sessionId) return undefined;

  const geminiTmpRoot = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(geminiTmpRoot)) return undefined;

  const preferredProjectDir = workingDirectory ? basename(workingDirectory) : null;
  const projectDirs = readdirSync(geminiTmpRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (preferredProjectDir && a === preferredProjectDir) return -1;
      if (preferredProjectDir && b === preferredProjectDir) return 1;
      return 0;
    });

  for (const projectDir of projectDirs) {
    const chatsDir = join(geminiTmpRoot, projectDir, 'chats');
    if (!existsSync(chatsDir)) continue;

    const sessionFiles = readdirSync(chatsDir)
      .filter((name) => name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl')))
      .map((name) => ({
        path: join(chatsDir, name),
        ext: (name.endsWith('.jsonl') ? '.jsonl' : '.json') as '.json' | '.jsonl',
        name,
        mtimeMs: statSync(join(chatsDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of sessionFiles) {
      if (file.ext === '.jsonl') {
        const headerSessionId = readJsonlHeaderSessionId(file.path);
        const headerMatch = headerSessionId === sessionId;
        const filenameMatch = headerSessionId == null && file.name.includes(sessionId.slice(0, 8));
        if (headerMatch || filenameMatch) return { path: file.path, ext: '.jsonl' };
        continue;
      }

      const parsed = parseGeminiSessionFile(file.path, '.json');
      if (parsed.sessionId === sessionId) return { path: file.path, ext: '.json' };
    }
  }

  return undefined;
}

function readLatestGeminiContextTokens(
  sessionId: string | undefined,
  assistantText: string,
  workingDirectory?: string,
): number | undefined {
  const location = findGeminiSessionFile(sessionId, workingDirectory);
  if (!location) return undefined;

  const normalizedAssistantText = normalizeGeminiContent(assistantText);
  const hasInputTokens = (parsed: unknown): parsed is GeminiStoredMessage => {
    if (parsed == null || typeof parsed !== 'object') return false;
    const message = parsed as GeminiStoredMessage;
    return message.type === 'gemini' && typeof message.tokens?.input === 'number';
  };
  const matchesAssistantText = (parsed: unknown): boolean => {
    if (!hasInputTokens(parsed)) return false;
    return matchesCurrentAssistantText(parsed.content, normalizedAssistantText);
  };

  if (location.ext === '.jsonl') {
    const predicate = normalizedAssistantText.length === 0 ? hasInputTokens : matchesAssistantText;
    return readJsonlTail<GeminiStoredMessage>(location.path, { predicate })?.tokens?.input;
  }

  const parsed = parseGeminiSessionFile(location.path, '.json');
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const candidates = messages.filter(hasInputTokens);
  if (candidates.length === 0) return undefined;
  if (normalizedAssistantText.length === 0) return candidates[candidates.length - 1]?.tokens?.input;

  return [...candidates]
    .reverse()
    .find((message) => matchesCurrentAssistantText(message.content, normalizedAssistantText))?.tokens?.input;
}

function formatAgyPrintTimeout(timeoutMs: number): string | null {
  if (timeoutMs <= 0) return null;
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function removeValuedCliFlags(args: readonly string[], flags: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg == null) continue;
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0 && flags.has(arg.slice(0, equalsIndex))) {
      continue;
    }
    if (flags.has(arg)) {
      const nextArg = args[i + 1];
      if (nextArg != null && !nextArg.startsWith('-')) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

const ANTIGRAVITY_USER_BLOCKED_FLAGS = new Set(['--dangerously-skip-permissions']);

function insertArgsBeforeFlag(args: string[], flag: string, insertion: readonly string[]): void {
  const index = args.indexOf(flag);
  if (index >= 0) {
    args.splice(index, 0, ...insertion);
    return;
  }
  args.push(...insertion);
}

function readAntigravityLogText(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function removeAntigravityLogFile(logPath: string): void {
  try {
    rmSync(logPath, { force: true });
  } catch {
    // Best-effort cleanup only; provider result delivery should not fail on temp-file deletion.
  }
}

function resolveAgyDebugHomeMode(
  agyProfile: AgyProfile | null,
  childEnv: NodeJS.ProcessEnv | undefined,
): NonNullable<CliDiagnostics['debugRef']['homeMode']> {
  if (agyProfile) return 'agy_profile_home';
  return typeof childEnv?.HOME === 'string' && childEnv.HOME.trim().length > 0 ? 'child_env_home' : 'process_home';
}

function buildAgyDebugRef(input: {
  readonly agyProfile: AgyProfile | null;
  readonly childEnv: NodeJS.ProcessEnv | undefined;
  readonly spawnCwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | string | null;
  readonly invocationId?: string;
}): CliDiagnostics['debugRef'] {
  const spawnCwdBasename = basename(input.spawnCwd);
  const spawnCwdKey = /^[a-f0-9]{16}$/.test(spawnCwdBasename) ? spawnCwdBasename : undefined;
  return {
    command: 'agy',
    exitCode: input.exitCode,
    signal: input.signal,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    homeMode: resolveAgyDebugHomeMode(input.agyProfile, input.childEnv),
    spawnCwdMode: input.agyProfile ? 'agy_profile_cwd' : 'cat_cafe_agy_cwd',
    ...(spawnCwdKey ? { spawnCwdKey } : {}),
    ...(input.agyProfile ? { profileId: input.agyProfile.profileId } : {}),
  };
}

function pickAgyDebugRefExtras(
  debugRef: CliDiagnostics['debugRef'],
): Pick<CliDiagnostics['debugRef'], 'homeMode' | 'spawnCwdMode' | 'spawnCwdKey' | 'profileId'> {
  return {
    ...(debugRef.homeMode ? { homeMode: debugRef.homeMode } : {}),
    ...(debugRef.spawnCwdMode ? { spawnCwdMode: debugRef.spawnCwdMode } : {}),
    ...(debugRef.spawnCwdKey ? { spawnCwdKey: debugRef.spawnCwdKey } : {}),
    ...(debugRef.profileId ? { profileId: debugRef.profileId } : {}),
  };
}

function withAgyDebugRefExtras(
  diagnostics: CliDiagnostics | undefined,
  extras: Pick<CliDiagnostics['debugRef'], 'homeMode' | 'spawnCwdMode' | 'spawnCwdKey' | 'profileId'>,
): CliDiagnostics | undefined {
  return diagnostics
    ? {
        ...diagnostics,
        debugRef: {
          ...diagnostics.debugRef,
          ...extras,
        },
      }
    : undefined;
}

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
  /** Override adapter selection (default: GEMINI_ADAPTER env or antigravity-cli) */
  adapter?: GeminiAdapter;
  /** F210 Phase G: optional isolated AGY HOME/settings profile. */
  agyProfile?: AgyProfileConfig;
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
  private readonly agyProfileConfig: AgyProfileConfig | undefined;
  constructor(options?: GeminiAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('gemini');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
    this.antigravitySpawnFn = options?.antigravitySpawnFn ?? nodeSpawn;
    this.adapter =
      options?.adapter ?? (process.env.GEMINI_ADAPTER as GeminiAdapter | undefined) ?? DEFAULT_GEMINI_ADAPTER;
    this.agyProfileConfig = options?.agyProfile;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    if (this.adapter === 'antigravity') {
      yield* this.invokeAntigravity(prompt, options);
    } else if (this.adapter === 'antigravity-cli') {
      yield* this.invokeAntigravityCLI(prompt, options);
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
    const modelArgs = effectiveModel ? ['--model', effectiveModel] : [];
    const args: string[] = options?.sessionId
      ? ['--resume', options?.sessionId!, ...modelArgs, '-p', effectivePrompt, '-o', 'stream-json', '-y']
      : [...modelArgs, '-p', effectivePrompt, '-o', 'stream-json', '-y'];
    for (const dir of imageAccessDirs) {
      args.push('--include-directories', dir);
    }

    // User-defined CLI args from the member editor (#567).
    const userParts: string[] = [];
    for (const arg of options?.cliConfigArgs ?? []) {
      userParts.push(...arg.trim().split(/\s+/));
    }
    if (userParts.length > 0) {
      const accumulativeFlags = new Set(['--include-directories']);
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
      let fullAssistantText = '';
      const cliOpts = {
        command: geminiCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv || options?.accountEnv
          ? { env: { ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) } }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
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
            error: `暹罗猫 CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            // F212 Phase A (云端 codex P2): timeout cliDiagnostics 也透传到 metadata.
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        // F118 Phase C: Forward liveness warnings to frontend with catId
        if (isLivenessWarning(event)) {
          const warningEvent = event as { level?: string; silenceDurationMs?: number };
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: warningEvent.level,
              silenceMs: warningEvent.silenceDurationMs,
            },
            '[GeminiAgent] liveness warning — CLI may be stuck',
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
          if (sawResultError || suppressCliExitError) continue;
          // F212 Phase A: forward cliDiagnostics on metadata for frontend folded panel (Phase B).
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Gemini CLI', event),
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          continue;
        }

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
              // #679: Gemini CLI stats are cumulative across all turns in a session,
              // not per-turn context fill. Flag so auto-seal doesn't misuse them.
              usage.isCumulativeUsage = true;
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
            // Gemini CLI stream-json emits each content chunk as a separate
            // message/assistant event with delta:true. These are streaming
            // deltas, not complete turns. Raw concat is correct; the model's
            // own content includes newlines where paragraph breaks are intended.
            fullAssistantText += result.content ?? '';
            yield { ...result, metadata };
            sawAssistantText = true;
          } else {
            if (fromResultError && result.type === 'error') {
              sawResultError = true;
            }
            yield { ...result, metadata };
          }
        }
      }

      const thinking = readGeminiThinkingFromLocalSession(
        metadata.sessionId,
        fullAssistantText,
        options?.workingDirectory,
      );
      if (thinking) {
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thinking }),
          metadata,
          timestamp: Date.now(),
        };
      }

      const lastTurnTokens = readLatestGeminiContextTokens(
        metadata.sessionId,
        fullAssistantText,
        options?.workingDirectory,
      );
      if (lastTurnTokens != null) {
        metadata.usage = { ...(metadata.usage ?? {}), lastTurnInputTokens: lastTurnTokens };
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

  private async *invokeAntigravityCLI(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const yieldedToolCallIds = new Set<string>();
    const yieldedToolResults = new Set<string>();
    const requestedModelOverride = options?.callbackEnv?.CAT_CAFE_GEMINI_MODEL_OVERRIDE;
    // F210 cache-leak fix (cloud P2)：normalize 成绝对路径。spawn cwd 现在是独立 sandbox（与
    // workingDirectory 解耦），若 workingDirectory 是相对路径（AgentServiceOptions 不强制绝对，
    // 直连 caller/测试可传 `.`），`--add-dir workingDirectory` 会相对 sandbox cwd 解析 → AGY 授权
    // 错目录、tool use 落到 workspace 外。resolve() 让 --add-dir + profile trust 都拿绝对路径
    // （`.` → process.cwd()，与改动前 cwd=workingDirectory 的语义一致）。
    const workingDirectory = resolve(options?.workingDirectory ?? process.cwd());
    let metadata: MessageMetadata = {
      provider: 'google',
      model: 'account-selected (antigravity-cli)',
      modelVerified: false,
      diagnostics: {
        antigravityCli: {
          modelSelection: 'account-side selected model',
          configuredCatModel: this.model,
          ...(requestedModelOverride ? { unsupportedModelOverride: requestedModelOverride } : {}),
        },
      },
    };
    let agyProfile: AgyProfile | null = null;
    try {
      agyProfile = resolveAgyProfile({
        catId: this.catId as string,
        expectedModel: this.model,
        workingDirectory,
        config: this.agyProfileConfig,
      });
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: `Antigravity CLI profile setup failed: ${err instanceof Error ? err.message : String(err)}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }
    if (agyProfile) {
      metadata = {
        provider: 'google',
        model: `${agyProfile.expectedModel} (antigravity-cli profile)`,
        modelVerified: false,
        diagnostics: {
          antigravityCli: {
            modelSelection: 'isolated profile settings',
            configuredCatModel: this.model,
            profile: {
              profileId: agyProfile.profileId,
              homePath: agyProfile.homePath,
              settingsPath: agyProfile.settingsPath,
              trustedWorkspaces: agyProfile.trustedWorkspaces,
              autoApprove: agyProfile.autoApprove,
            },
            ...(requestedModelOverride ? { unsupportedModelOverride: requestedModelOverride } : {}),
          },
        },
      };
    }

    let effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);

    const timeoutMs = resolveCliTimeoutMs(undefined);
    const printTimeout = formatAgyPrintTimeout(timeoutMs);
    const agyLogPath = options?.agyLogPathOverride ?? join(tmpdir(), `cat-cafe-agy-${randomUUID()}.log`);
    const args: string[] = ['--add-dir', workingDirectory];
    if (agyProfile?.autoApprove) {
      args.push('--dangerously-skip-permissions');
    }
    for (const dir of imageAccessDirs) {
      args.push('--add-dir', dir);
    }
    if (printTimeout) {
      args.push('--print-timeout', printTimeout);
    }
    const requestedSessionId = options?.sessionId;
    let emittedSessionInit = false;
    if (requestedSessionId) {
      metadata.sessionId = requestedSessionId;
      emittedSessionInit = true;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: requestedSessionId,
        metadata,
        timestamp: Date.now(),
      };
    }
    if (requestedModelOverride) {
      yield {
        type: 'system_info',
        catId: this.catId,
        content: JSON.stringify({
          type: 'antigravity_cli_model_override_unsupported',
          requestedModel: requestedModelOverride,
          reason: agyProfile
            ? 'AGY CLI profile model selection is configured through isolated settings; no verified per-call --model/env override exists.'
            : 'AGY CLI uses the account-side selected model; no verified per-call --model/env override exists.',
        }),
        metadata,
        timestamp: Date.now(),
      };
    }
    args.push('--print', effectivePrompt);

    const userParts: string[] = [];
    for (const arg of options?.cliConfigArgs ?? []) {
      userParts.push(...arg.trim().split(/\s+/));
    }
    const filteredUserParts = removeValuedCliFlags(userParts, ANTIGRAVITY_USER_BLOCKED_FLAGS);
    if (filteredUserParts.length > 0) {
      const accumulativeFlags = new Set(['--add-dir']);
      const userFlags = new Set(filteredUserParts.filter((p) => p.startsWith('-')));
      const deduped: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-') && userFlags.has(args[i]) && !accumulativeFlags.has(args[i])) {
          if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
          continue;
        }
        deduped.push(args[i]);
      }
      args.length = 0;
      args.push(...deduped, ...filteredUserParts);
    }
    const sanitizedArgs = removeValuedCliFlags(args, new Set(['--conversation', '--log-file']));
    args.length = 0;
    args.push(...sanitizedArgs);
    const internalAgyArgs = ['--log-file', agyLogPath];
    if (requestedSessionId) {
      internalAgyArgs.push('--conversation', requestedSessionId);
    }
    insertArgsBeforeFlag(args, '--print', internalAgyArgs);

    try {
      const agyCommand = resolveCliCommand('agy');
      if (!agyCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('agy'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
      if (agyProfile) {
        const preflight = preflightAgyProfile(agyProfile, { agyCommand, workingDirectory });
        if (!preflight.ok) {
          yield {
            type: 'error' as const,
            catId: this.catId,
            error: preflight.message,
            metadata: {
              ...metadata,
              diagnostics: {
                ...(metadata.diagnostics ?? {}),
                antigravityCli: {
                  ...((metadata.diagnostics?.antigravityCli as Record<string, unknown> | undefined) ?? {}),
                  preflight: {
                    ok: false,
                    reason: preflight.reason,
                  },
                },
              },
            },
            timestamp: Date.now(),
          };
          yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
          return;
        }
      }

      const childEnv =
        options?.callbackEnv || options?.accountEnv || agyProfile
          ? {
              ...(options?.callbackEnv ?? {}),
              ...(options?.accountEnv ?? {}),
              ...(agyProfile ? { HOME: agyProfile.homePath } : {}),
            }
          : undefined;
      let stdout = '';
      let stderr = '';
      let timeoutEvent:
        | {
            __cliTimeout: true;
            timeoutMs: number;
            message: string;
            command: string;
            silenceDurationMs?: number;
            processAlive?: boolean;
            lastEventType?: string;
            firstEventAt?: number;
            lastEventAt?: number;
            cliSessionId?: string;
            invocationId?: string;
            rawArchivePath?: string;
            // F212 Phase A (砚砚 2nd P2): cliDiagnostics piggyback on __cliTimeout
            cliDiagnostics?: import('../../../../../utils/cli-diagnostics.js').CliDiagnostics;
          }
        | undefined;
      let cliErrorEvent:
        | {
            __cliError: true;
            exitCode: number | null;
            signal: string | null;
            message: string;
            command: string;
            reasonCode?: string;
            // F212 Phase A: structured CLI diagnostics piggybacking on __cliError event
            cliDiagnostics?: import('../../../../../utils/cli-diagnostics.js').CliDiagnostics;
          }
        | undefined;
      let cancelled = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      const abortHandler = (): void => {
        cancelled = true;
      };
      if (options?.signal) {
        if (options.signal.aborted) {
          abortHandler();
        } else {
          options.signal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      // F210 H2a (B spike §8.3): capture invocation start BEFORE spawn so a resume-turn cascade db
      // (created after spawn) is newer than this watermark; appDataDir derived from the SAME effective
      // child HOME passed to AGY (childEnv.HOME — merges agyProfile/accountEnv/callbackEnv), because
      // resume-turn log is empty (agy doesn't write --log-file on resume) and the scan fallback in
      // locateAgyTrajectoryDb needs appDataDir independently of the log. 云端 codex P2: 不能用进程
      // homedir()，否则 accountEnv 提供 HOME 时会扫错目录、resume 永久零 progress。
      const agyInvocationStartMs = Date.now();
      const agyAppDataDir = resolveAgyAppDataDir(childEnv);
      const resumeTrajectoryDbName = requestedSessionId ? `${requestedSessionId}.db` : null;
      const resumeTrajectoryDbPath =
        resumeTrajectoryDbName && basename(resumeTrajectoryDbName) === resumeTrajectoryDbName
          ? join(agyAppDataDir, 'conversations', resumeTrajectoryDbName)
          : null;
      const resumeTrajectoryBaselineCursor =
        resumeTrajectoryDbPath !== null ? readAgyMaxStepIdx(resumeTrajectoryDbPath) : null;
      const resumeTrajectoryDbIdentity =
        resumeTrajectoryDbPath !== null && resumeTrajectoryBaselineCursor !== null
          ? readAgyDbFileIdentity(resumeTrajectoryDbPath)
          : null;
      const resumeTrajectoryBaselinePrefixFingerprintResult =
        resumeTrajectoryDbPath !== null && resumeTrajectoryBaselineCursor !== null
          ? readAgyStepsPrefixFingerprint(resumeTrajectoryDbPath, resumeTrajectoryBaselineCursor)
          : null;
      const resumeTrajectoryBaselinePrefixFingerprint =
        resumeTrajectoryBaselinePrefixFingerprintResult?.status === 'ok'
          ? resumeTrajectoryBaselinePrefixFingerprintResult.fingerprint
          : null;
      const initialCursorForDb =
        resumeTrajectoryDbPath !== null &&
        resumeTrajectoryBaselineCursor !== null &&
        resumeTrajectoryDbIdentity !== null &&
        resumeTrajectoryBaselinePrefixFingerprint !== null
          ? createAgyResumeBaselineCursorResolver({
              resumeDbPath: resumeTrajectoryDbPath,
              baselineCursor: resumeTrajectoryBaselineCursor,
              baselineIdentity: resumeTrajectoryDbIdentity,
              baselinePrefixFingerprint: resumeTrajectoryBaselinePrefixFingerprint,
            })
          : undefined;
      // F210 cache-leak fix (砚砚 cwd sandbox 方向)：spawn cwd 与 workingDirectory 解耦。AGY 写
      // cwd-relative cache（`cache/projects.json`）到 spawn cwd——cwd=repo root 时泄漏到 worktree
      // （实证 2026-06-03）。agyProfile 时 spawn cwd 指向 profile cwd sandbox（cwd-relative cache 落
      // profile 不 repo）；workspace 仍由上方 `args = ['--add-dir', workingDirectory]` 显式授权。
      const agySpawnCwd = resolveAgySpawnCwd(agyProfile, this.catId, workingDirectory);
      // F210 cache-leak diagnostics (砚砚 可选项)：把隔离后的 spawn cwd 写进 metadata，
      // runtime 日志 / 重启验证可直接确认 cwd 已 sandbox、不落 repo root。
      metadata = {
        ...metadata,
        diagnostics: {
          ...(metadata.diagnostics ?? {}),
          antigravityCli: {
            ...((metadata.diagnostics?.antigravityCli as Record<string, unknown> | undefined) ?? {}),
            spawnCwd: agySpawnCwd,
          },
        },
      };
      const cliOpts = {
        command: agyCommand,
        args,
        outputMode: 'plainText' as const,
        cwd: agySpawnCwd,
        timeoutMs,
        ...(childEnv ? { env: childEnv } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      // F210-H1b: agy `--print` (plainText) blocks until the process ends, so consume the spawn
      // stream in a background task while a side-channel progress observer polls the trajectory
      // SQLite. The final reply is still decided by the stdout handling below — progress is a pure
      // side-channel (system_info), and observeAgyProgress is fail-open (SQLite unavailable → zero
      // output), so this never changes final-answer semantics.
      let agyFinished = false;
      // F210-H1b (cloud P1): capture a consumer rejection immediately so the background task never
      // rejects without a handler during the merge-loop wait. Re-thrown after the buffer drains so
      // the existing top-level catch yields a normal error+done.
      let consumerError: unknown = null;
      const sideChannelBuffer: AgentMessage[] = [];
      const agyConsumeTask = (async () => {
        try {
          for await (const event of events) {
            if (isCliPlainTextResult(event)) {
              stdout = event.stdout;
              stderr = event.stderr;
              exitCode = event.exitCode;
              exitSignal = event.signal;
              continue;
            }
            if (isCliTimeout(event)) {
              timeoutEvent = event;
              continue;
            }
            if (isCliError(event)) {
              cliErrorEvent = event;
              continue;
            }
            if (isLivenessWarning(event)) {
              sideChannelBuffer.push({
                type: 'system_info' as const,
                catId: this.catId,
                content: JSON.stringify({ type: 'liveness_warning', ...event }),
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          consumerError = err;
        } finally {
          if (options?.signal) {
            options.signal.removeEventListener('abort', abortHandler);
          }
          agyFinished = true;
        }
      })();

      const progressGen = observeAgyProgress({
        readLog: () => readAntigravityLogText(agyLogPath),
        isAgyDone: () => agyFinished,
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }),
        // F210 H2a (B spike §8.3): resume turn 的 log 为空，靠扫 conversations/*.db 定位本轮
        // 新建 cascade db（只认 invocationStart 后的单一候选；0/多 → fail-open）。
        appDataDir: agyAppDataDir,
        invocationStartMs: agyInvocationStartMs,
        listConversationDbs: listAgyConversationDbs,
        ...(initialCursorForDb ? { initialCursorForDb } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      // Merge loop: drain the side-channel buffer (liveness) on a timer so it stays real-time even
      // when progress yields nothing (fail-open / no new step). Buffering liveness until AGY
      // completion would be worse than the pre-H1b real-time behavior (砚砚 P1-2). race(progress,
      // timer) keeps both side channels live without one starving the other.
      const SIDE_CHANNEL_DRAIN_MS = 200;
      const progressIter = progressGen[Symbol.asyncIterator]();
      let progressNext: Promise<IteratorResult<AgyProgressEvent>> | null = progressIter.next();
      while (progressNext !== null || sideChannelBuffer.length > 0) {
        while (sideChannelBuffer.length > 0) {
          yield sideChannelBuffer.shift()!;
        }
        if (progressNext === null) break;
        const settled = await Promise.race([
          progressNext.then((res) => ({ kind: 'progress' as const, res })),
          new Promise<{ kind: 'timer' }>((resolve) => {
            setTimeout(() => resolve({ kind: 'timer' }), SIDE_CHANNEL_DRAIN_MS);
          }),
        ]);
        if (settled.kind === 'progress') {
          if (settled.res.done) {
            progressNext = null;
          } else {
            const progress = settled.res.value;
            yield {
              type: 'system_info' as const,
              catId: this.catId,
              content: JSON.stringify({
                type: 'agy_trajectory_progress',
                idx: progress.idx,
                stepType: progress.stepType,
                status: progress.status,
                label: progress.label,
              }),
              timestamp: Date.now(),
            };
            if (progress.payload) {
              const toolInfo = parseAgyStepTools(progress.payload, progress.idx);
              if (toolInfo && toolInfo.toolName && toolInfo.toolCallId) {
                const { toolName, toolCallId, toolInput, toolResultOutput } = toolInfo;
                if (!yieldedToolCallIds.has(toolCallId)) {
                  yieldedToolCallIds.add(toolCallId);
                  yield {
                    type: 'tool_use',
                    catId: this.catId,
                    toolName,
                    toolInput,
                    toolUseId: toolCallId,
                    metadata,
                    timestamp: Date.now(),
                  };
                }
                if (progress.status === 3 && !yieldedToolResults.has(toolCallId)) {
                  yieldedToolResults.add(toolCallId);
                  yield {
                    type: 'tool_result',
                    catId: this.catId,
                    toolName,
                    content: toolResultOutput ?? '',
                    toolUseId: toolCallId,
                    toolResultStatus: 'ok',
                    metadata,
                    timestamp: Date.now(),
                  };
                }
              }
            }
            progressNext = progressIter.next();
          }
        }
        // timer winner → loop back to drain the buffer; progressNext promise stays pending (reused).
      }
      await agyConsumeTask;
      while (sideChannelBuffer.length > 0) {
        yield sideChannelBuffer.shift()!;
      }
      if (consumerError) {
        throw consumerError instanceof Error ? consumerError : new Error(String(consumerError));
      }

      const agyLogText = readAntigravityLogText(agyLogPath);
      const observedProfileModel = agyProfile ? extractAntigravityCliSelectedModelLabel(agyLogText) : null;
      const profileModelMissing = Boolean(agyProfile && !observedProfileModel);
      const profileModelMismatch = Boolean(
        agyProfile && observedProfileModel && observedProfileModel !== agyProfile.expectedModel,
      );
      if (agyProfile && observedProfileModel) {
        metadata = {
          ...metadata,
          model: `${observedProfileModel} (antigravity-cli profile)`,
          modelVerified: !profileModelMismatch,
          diagnostics: {
            ...(metadata.diagnostics ?? {}),
            antigravityCli: {
              ...((metadata.diagnostics?.antigravityCli as Record<string, unknown> | undefined) ?? {}),
              observedModel: observedProfileModel,
            },
          },
        };
      }
      // F210 H2b: resumed turn 从 trajectory 提取本轮 final answer 替换 stdout 重放（根治
      // `agy --print --conversation` 累加重放）。agy resume log 为空 → locator 走扫描定位 resume
      // 新 cascade db；任何环节失败（无 db / 无 final）→ resumedFinalText=null，classify fail-open
      // 保留现有 stdout。
      let resumedFinalText: string | null = null;
      if (options?.sessionId) {
        const dbPath = locateAgyTrajectoryDb({
          logText: agyLogText,
          appDataDir: agyAppDataDir,
          invocationStartMs: agyInvocationStartMs,
          listConversationDbs: listAgyConversationDbs,
        });
        if (dbPath) {
          resumedFinalText = extractAgyFinalTextFromSteps(readAgyTrajectorySteps(dbPath));
        }
      }
      const parsedPlainText = classifyAntigravityCliPlainText({
        stdout,
        stderr,
        resumed: Boolean(options?.sessionId),
        agyLogText,
        resumedFinalText,
      });
      const diagnosticInvocationId = resolveDiagnosticInvocationId(options);
      const agyDebugRef = buildAgyDebugRef({
        agyProfile,
        childEnv,
        spawnCwd: agySpawnCwd,
        exitCode,
        signal: exitSignal,
        ...(diagnosticInvocationId ? { invocationId: diagnosticInvocationId } : {}),
      });
      const agyDebugRefExtras = pickAgyDebugRefExtras(agyDebugRef);
      const agyDiagnosticHomePaths =
        typeof childEnv?.HOME === 'string' && childEnv.HOME.trim().length > 1 ? [childEnv.HOME] : undefined;
      const stderrPresent = stderr.trim().length > 0;
      const sanitizedAgyStderr = stderrPresent
        ? sanitizeCliStderr(
            stderr,
            agyDiagnosticHomePaths ? { additionalHomePaths: agyDiagnosticHomePaths } : undefined,
          )
        : '';
      const agyExitDiagnostics =
        exitCode !== 0 || exitSignal !== null || cliErrorEvent
          ? buildCliDiagnostics({
              // Exit fallback diagnostics are user-visible, so they only classify
              // stderr. AGY stdout may contain partial/private model text; stdout
              // is admitted separately only through the provider-safe plain-text parser.
              rawText: stderr,
              // rawText still drives classification, but public excerpts are admitted
              // only from sanitized stderr; unknown debug stderr stays closed.
              safeExcerptRawText: sanitizedAgyStderr,
              debugRef: agyDebugRef,
              stderrEmpty: !stderrPresent,
              ...(agyDiagnosticHomePaths ? { additionalHomePaths: agyDiagnosticHomePaths } : {}),
            })
          : undefined;
      const parsedPlainTextDiagnostics =
        parsedPlainText.kind === 'error'
          ? buildCliDiagnostics({
              // Use the parser's provider-safe message here, not raw stdout, so AGY OAuth URLs
              // never leak into the user-facing diagnostics payload.
              rawText: parsedPlainText.error,
              debugRef: agyDebugRef,
              stderrEmpty: !stderrPresent,
              ...(agyDiagnosticHomePaths ? { additionalHomePaths: agyDiagnosticHomePaths } : {}),
            })
          : undefined;
      const emptyPlainTextStderrDiagnostics =
        parsedPlainText.kind === 'empty' && stderrPresent
          ? buildCliDiagnostics({
              rawText: stderr,
              // rawText still drives classification, but the public excerpt is pre-sanitized
              // before admission so OAuth fragments and child HOME paths cannot leak.
              safeExcerptRawText: sanitizedAgyStderr,
              debugRef: agyDebugRef,
              stderrEmpty: false,
              ...(agyDiagnosticHomePaths ? { additionalHomePaths: agyDiagnosticHomePaths } : {}),
            })
          : undefined;
      const emptyPlainTextDiagnostics =
        parsedPlainText.kind === 'empty'
          ? emptyPlainTextStderrDiagnostics?.reasonCode
            ? emptyPlainTextStderrDiagnostics
            : buildSilentCompletionDiagnostic({
                command: 'agy',
                ...(diagnosticInvocationId ? { invocationId: diagnosticInvocationId } : {}),
                // AGY --print is plain text, not NDJSON. Use a synthetic event marker so
                // the F212 silent-completion panel can distinguish this path honestly.
                eventCount: 1,
                eventTypes: ['plain_text_empty'],
                model: metadata.model,
                sessionId: options?.sessionId ?? metadata.sessionId,
                exitCode,
                stderrPresent,
                ...(stderrPresent ? { stderrExcerpt: stderr } : {}),
                ...(agyDiagnosticHomePaths ? { additionalHomePaths: agyDiagnosticHomePaths } : {}),
                debugRefExtras: agyDebugRefExtras,
              })
          : undefined;
      const actionableEmptyPlainTextDiagnostics =
        emptyPlainTextDiagnostics?.reasonCode && emptyPlainTextDiagnostics.reasonCode !== 'silent_completion'
          ? emptyPlainTextDiagnostics
          : undefined;
      const timeoutCliDiagnostics = withAgyDebugRefExtras(timeoutEvent?.cliDiagnostics, agyDebugRefExtras);
      const cliErrorEventDiagnostics = withAgyDebugRefExtras(cliErrorEvent?.cliDiagnostics, agyDebugRefExtras);
      const canRecordFreshConversation =
        !emittedSessionInit &&
        parsedPlainText.kind === 'text' &&
        !timeoutEvent &&
        !cancelled &&
        !cliErrorEvent &&
        !profileModelMismatch &&
        !profileModelMissing &&
        exitCode === 0 &&
        exitSignal === null;
      if (canRecordFreshConversation) {
        const observedSessionId = extractAntigravityCliConversationId(agyLogText);
        if (observedSessionId) {
          metadata.sessionId = observedSessionId;
          emittedSessionInit = true;
          yield {
            type: 'session_init',
            catId: this.catId,
            sessionId: observedSessionId,
            metadata,
            timestamp: Date.now(),
          };
        }
      }

      if (timeoutEvent) {
        yield {
          type: 'system_info' as const,
          catId: this.catId,
          content: JSON.stringify({
            type: 'timeout_diagnostics',
            silenceDurationMs: timeoutEvent.silenceDurationMs,
            processAlive: timeoutEvent.processAlive,
            lastEventType: timeoutEvent.lastEventType,
            firstEventAt: timeoutEvent.firstEventAt,
            lastEventAt: timeoutEvent.lastEventAt,
            invocationId: timeoutEvent.invocationId ?? options?.invocationId,
            cliSessionId: timeoutEvent.cliSessionId ?? options?.cliSessionId,
            rawArchivePath: timeoutEvent.rawArchivePath,
          }),
          timestamp: Date.now(),
        };
        // F212 Phase A (砚砚 2nd P2): Antigravity CLI timeout collector path 也透传 cliDiagnostics.
        yield {
          type: 'error',
          catId: this.catId,
          error: `Antigravity CLI 响应超时 (${Math.round(timeoutEvent.timeoutMs / 1000)}s)`,
          metadata: timeoutCliDiagnostics ? { ...metadata, cliDiagnostics: timeoutCliDiagnostics } : metadata,
          timestamp: Date.now(),
        };
      } else if (cancelled) {
        // User-initiated cancellation should clear frontend loading without
        // presenting a provider failure, even if AGY already wrote error text.
      } else if (parsedPlainText.kind === 'error') {
        yield {
          type: 'error',
          catId: this.catId,
          error: parsedPlainText.error,
          metadata: parsedPlainTextDiagnostics ? { ...metadata, cliDiagnostics: parsedPlainTextDiagnostics } : metadata,
          timestamp: Date.now(),
        };
      } else if (cliErrorEvent) {
        // F212 Phase A: forward cliDiagnostics on metadata for frontend folded panel (Phase B).
        // AGY plain-text spawn yields __cliPlainText followed by __cliError on nonzero exit; rebuild
        // diagnostics here so raw stdout/stderr, auditContext invocation, and isolated child HOME
        // redaction are applied before the public payload.
        yield {
          type: 'error',
          catId: this.catId,
          error: formatCliExitError('Antigravity CLI', cliErrorEvent),
          metadata: agyExitDiagnostics
            ? { ...metadata, cliDiagnostics: agyExitDiagnostics }
            : cliErrorEventDiagnostics
              ? { ...metadata, cliDiagnostics: cliErrorEventDiagnostics }
              : metadata,
          timestamp: Date.now(),
        };
      } else if (exitCode !== 0 || exitSignal !== null) {
        yield {
          type: 'error',
          catId: this.catId,
          error: formatCliExitError('Antigravity CLI', {
            exitCode,
            signal: exitSignal,
            message: `CLI 异常退出 (code: ${exitCode ?? 'null'}, signal: ${exitSignal ?? 'none'})`,
          }),
          metadata: agyExitDiagnostics ? { ...metadata, cliDiagnostics: agyExitDiagnostics } : metadata,
          timestamp: Date.now(),
        };
      } else if (parsedPlainText.kind === 'empty' && actionableEmptyPlainTextDiagnostics) {
        yield {
          type: 'error',
          catId: this.catId,
          error: actionableEmptyPlainTextDiagnostics.publicSummary,
          metadata: { ...metadata, cliDiagnostics: actionableEmptyPlainTextDiagnostics },
          timestamp: Date.now(),
        };
      } else if (agyProfile && profileModelMismatch) {
        yield {
          type: 'error',
          catId: this.catId,
          error: `AGY profile selected model mismatch: expected "${agyProfile.expectedModel}", observed "${observedProfileModel}".`,
          metadata,
          timestamp: Date.now(),
        };
      } else if (agyProfile && profileModelMissing) {
        yield {
          type: 'error',
          catId: this.catId,
          error: `AGY profile selected model was not verified: expected "${agyProfile.expectedModel}", but no selected model label was observed in AGY logs.`,
          metadata,
          timestamp: Date.now(),
        };
      } else if (parsedPlainText.kind === 'empty') {
        yield {
          type: 'system_info' as const,
          catId: this.catId,
          content: JSON.stringify({
            type: 'silent_completion',
            detail: 'Antigravity CLI completed without textual output.',
          }),
          metadata: emptyPlainTextDiagnostics ? { ...metadata, cliDiagnostics: emptyPlainTextDiagnostics } : metadata,
          timestamp: Date.now(),
        };
      } else if (parsedPlainText.kind === 'text') {
        yield {
          type: 'text',
          catId: this.catId,
          content: parsedPlainText.content,
          ...(parsedPlainText.textMode ? { textMode: parsedPlainText.textMode } : {}),
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
      removeAntigravityLogFile(agyLogPath);
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
      // Clone all env, strip bloated vars (LS_COLORS etc.) to avoid E2BIG,
      // then merge callbackEnv overrides. Preserves API keys etc. from parent env.
      const childEnv = buildChildEnv(options.callbackEnv);

      const child = this.antigravitySpawnFn('antigravity', ['chat', '--mode', 'agent', prompt], {
        detached: true,
        stdio: 'ignore',
        env: childEnv as Record<string, string>,
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
              log.debug({ pid }, `[gemini] Antigravity process group killed via signal`);
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
