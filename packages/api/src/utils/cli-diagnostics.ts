/**
 * F212 Phase A — CLI error diagnostics builder + classifier.
 *
 * Public API:
 *  - `classifyCliError(text)`: text → reasonCode | undefined
 *  - `buildCliDiagnostics({ rawText, debugRef })`: full CliDiagnostics payload
 *
 * Design contract:
 *  - KD-1 (white-list admission): safeExcerpt only filled when reasonCode !== undefined
 *  - KD-2 (sanitize then truncate): sanitize entire rawText before slicing windows
 *  - AC-A6: panic stack frames stripped from safeExcerpt (headline surfaces in publicSummary)
 *  - AC-A9 red line: no raw stderr ever in publicSummary / publicHint (humanized only)
 */

import type { CliDiagnostics, CliErrorReasonCode } from '@cat-cafe/shared';
import { CLASSIFIER_PATTERNS } from './cli-error-patterns.js';
import { sanitizeCliStderr } from './sanitize-cli-stderr.js';

// F212 Phase B: CliDiagnostics + CliErrorReasonCode hoisted to @cat-cafe/shared so the web
// folded panel can import the same contract. Re-exported here for existing api callers.
export type { CliDiagnostics, CliErrorReasonCode };

/**
 * F212 AC-A4 + AC-A8: classify stderr OR NDJSON stream error text into known reasonCodes.
 * Returns undefined for unknown; callers must surface generic message + never expose raw text.
 */
export function classifyCliError(text: string): CliErrorReasonCode | undefined {
  if (!text) return undefined;
  for (const { code, regex } of CLASSIFIER_PATTERNS) {
    if (regex.test(text)) return code;
  }
  return undefined;
}

// =============================================================================
// Reason-code → humanized text map (Phase A: zh-CN only; Phase B/C may add i18n)
// =============================================================================

const REASON_TEXT: Record<CliErrorReasonCode, { summary: string; hint: string }> = {
  invalid_thinking_signature: {
    summary: 'Thinking 签名校验失败',
    hint: '换一只猫，或刷新对话后再试。',
  },
  missing_rollout: {
    summary: 'CLI session 找不到',
    hint: '对话上下文被外部清理了，发条新消息重建 session 即可。',
  },
  model_not_found: {
    summary: '模型名不被支持',
    hint: '检查 CLI 配置里的模型名拼写，或查 provider 官方支持列表（常见拼错：deepseek-v-4 应为 deepseek-v4-pro / deepseek-v4-flash）。',
  },
  auth_failed: {
    summary: 'API 认证失败',
    hint: '检查 .env 或 Console 里 provider 的 API key 是否正确、未过期。',
  },
  quota_exceeded: {
    summary: 'API 配额超限',
    hint: '当前 API key 已达限额，等几分钟再试，或检查 provider 的 quota 仪表盘。',
  },
  network_error: {
    summary: '网络连接失败',
    hint: '检查代理 / VPN / 防火墙；provider 上游也可能短暂不可用。',
  },
  invalid_config: {
    summary: 'CLI 配置文件无效',
    hint: '检查 config.toml / settings.json 语法和字段名（被外部工具改坏过？）。',
  },
  spawn_failed: {
    summary: 'CLI 进程无法启动',
    hint: '检查 CLI 是否已安装（`which codex` / `which claude` 等）和文件权限。',
  },
  context_window_exceeded: {
    summary: '对话上下文超长',
    hint: '开新 thread，或先精简 thread 历史再试。',
  },
  tool_call_parse_failed: {
    summary: '模型工具调用解析失败',
    hint: 'Claude Code 报告：模型输出的 tool call 无法解析（已重试仍失败）——这是模型 / CC 侧问题，非猫咖配置。换一只猫或刷新对话重试；频繁出现可换 model。',
  },
  server_overloaded: {
    // F212 Phase E — cloud codex R2 P2 fix (2026-05-30 on adf26db37): summary/hint MUST be
    // provider-neutral. The classifier is shared by spawnCli for all CLI providers (claude /
    // codex / gemini / antigravity — see SERVICE_MANIFESTS), and the broad regex matches
    // generic 529 Overloaded / "Server is busy" patterns from any upstream. Hard-coding
    // "Anthropic" misdiagnoses non-Claude provider failures + sends users to the wrong
    // status page. Keep regex broad (correct cross-provider coverage), make text neutral.
    summary: '上游 CLI provider 服务临时限流',
    // Plain text only — CliDiagnosticsPanel renders publicHint inside a <span> verbatim
    // (no markdown parser). @gpt52 R1 BLOCKED + cloud codex R1 P2 both caught the earlier
    // Markdown version. Provider-neutral phrasing per cloud codex R2 P2.
    hint: '不是你的额度问题——是 CLI 上游 provider 服务器侧临时限流（provider 错误里通常会明示如 "not your usage limit" / "529 Overloaded"）。等 30-60 秒重试或换一只猫（不同 provider）；反复出现去你用的 provider 状态页（Anthropic / OpenAI / Google / DeepSeek 各有 status 页）。',
  },
  // F212 Phase G (AC-G1): silent_completion — CLI 正常完成但事件流里没有 text event
  // (e.g. OpenCode + DeepSeek 用户撞的 step_start-only NDJSON, clowder-ai#875)。NOT 真错误
  // 但走 cliDiagnostics surface 让用户拿到结构化证据替代 generic "completed without
  // textual output"。具体 evidence (event count + types + model + session prefix) 在
  // metadata 的 cliDiagnostics 字段里，hint 给可操作建议。
  silent_completion: {
    summary: 'CLI 完成但无文字输出',
    // R1 P1 fix (砚砚 catch 2026-06-08): evidence (eventCount / eventTypes / model /
    // sessionIdPrefix / stderrPresent) lives in `safeExcerpt` (JSON), surfaced by the
    // panel's expandable disclosure. debugRef only carries command / exit / signal /
    // invocationId. Previous hint sent users to debugRef — wrong place, killed UX value.
    hint: 'CLI 进程正常退出且收到了事件流，但没有 text event（常见于 OpenCode + DeepSeek 上游问题）。建议：换一只猫试同样 prompt；换 model；或直接在终端跑 CLI 看 raw output 判断是 upstream 还是 prompt 问题。展开下方"详细诊断"查看 event 类型/数量、model、session 前缀等结构化证据；debugRef.invocationId 可用于后端日志检索。',
  },
};

const UNKNOWN_TEXT = {
  summary: '未识别的 CLI 错误',
  // Legacy fallback (callers without stderrEmpty signal). Phase F adds split-by-stderrEmpty
  // variants below — UNKNOWN_HINT_EMPTY_STDERR for empty case (don't promise more from
  // env var), UNKNOWN_HINT_HAS_STDERR for non-empty (point to env-summary, NOT raw path).
  hint: '详细诊断信息见后端日志（启用：环境变量 LOG_CLI_STDERR=1）。',
};

// F212 Phase F (AC-F4): empty-stderr honest hint. Do NOT mention LOG_CLI_STDERR — empty
// stderr means env gate would write nothing anyway (砚砚 cross thread 2026-05-30 catch:
// previous hint suggested LOG_CLI_STDERR=1 gives more info, but for empty-stderr it doesn't).
const UNKNOWN_HINT_EMPTY_STDERR =
  'CLI 已退出但没有输出 stderr。请在后端日志中用 debugRef.invocationId 搜索；如仍无结果，请直接运行该 CLI 并分别捕获 stdout/stderr。';

// F212 Phase F (AC-F5): non-empty stderr hint. Point to /api/config/env-summary for log dir
// lookup (the response carries paths.dataDirs.runtimeLogs) — never embed absolute path in
// payload (砚砚 push back: F212 安全边界 = no raw path / no path leak).
const UNKNOWN_HINT_HAS_STDERR =
  '详细诊断信息见后端日志。运行时日志目录可通过 GET /api/config/env-summary 的 paths.dataDirs.runtimeLogs 字段查询，再用 debugRef.invocationId 搜索对应行。';

// =============================================================================
// safeExcerpt extraction (KD-2: sanitize first, slice after)
// =============================================================================

const MAX_LINES = 8;
const MAX_CHARS = 1500;
const MAX_SILENT_EVENT_TYPES = 10;
const MAX_SILENT_EVENT_TYPE_CHARS = 40;
const MAX_SILENT_MODEL_CHARS = 80;
const MAX_SILENT_STDERR_CHARS = 500;
/** AC-A6: stack frame patterns — rust frame numbers / `at <file>` / cargo / node_modules */
const FRAME_REGEX = /^\s*\d+:\s|^\s*at\s/;

function truncateEvidenceString(value: string, maxChars: number): string {
  const sanitized = sanitizeCliStderr(value).replace(/\s+/g, ' ').trim();
  if (sanitized.length <= maxChars) return sanitized;
  if (maxChars <= 3) return sanitized.slice(0, maxChars);
  return `${sanitized.slice(0, maxChars - 3)}...`;
}

/**
 * R3 P1 fix (#857): aggressive path redaction for non-HOME absolute paths.
 * sanitizeCliStderr only handles HOME/USERPROFILE/C:\Users/tmp — server installs
 * under /srv, /workspace, /var/lib, D:\work would leak raw paths. This helper
 * strips ALL multi-segment absolute paths (both Unix and Windows) that survived
 * the HOME sanitizer. Used by unknown_raw + silent_completion evidence surfaces.
 */
function redactNonHomePaths(input: string): string {
  return input
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>|]+\\)*[^\s"'`<>|]+/g, '[PATH_REDACTED]')
    .replace(/(^|[\s"'`(=:[{,])\/(?!tmp\/\[REDACTED\])(?:[^\s"'`<>{}|]+\/)+[^\s"'`<>{}|]+/g, '$1[PATH_REDACTED]');
}

function truncateSilentEvidenceString(value: string, maxChars: number): string {
  const sanitized = redactNonHomePaths(sanitizeCliStderr(value)).replace(/\s+/g, ' ').trim();
  if (sanitized.length <= maxChars) return sanitized;
  if (maxChars <= 3) return sanitized.slice(0, maxChars);
  return `${sanitized.slice(0, maxChars - 3)}...`;
}

function extractSafeExcerpt(rawText: string, reasonCode: CliErrorReasonCode): string {
  // KD-2: sanitize entire blob first; truncation happens on sanitized output.
  const sanitized = sanitizeCliStderr(rawText);
  const allLines = sanitized.split('\n');
  // Keep meaningful lines (non-empty after trim) but preserve original line content (don't trim away whitespace details).
  const lines = allLines.filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';

  // Find headline line that matches the classifier regex
  const pattern = CLASSIFIER_PATTERNS.find((p) => p.code === reasonCode)?.regex;
  let hitIdx = -1;
  if (pattern) {
    hitIdx = lines.findIndex((l) => pattern.test(l));
  }
  if (hitIdx < 0) {
    // Fall back to first MAX_LINES non-frame lines
    return lines
      .filter((l) => !FRAME_REGEX.test(l))
      .slice(0, MAX_LINES)
      .join('\n')
      .slice(0, MAX_CHARS);
  }

  // Take headline + up to 3 lines before + 4 lines after, skipping frame lines
  const candidates: string[] = [];
  for (let i = Math.max(0, hitIdx - 3); i < hitIdx; i++) candidates.push(lines[i]!);
  const headline = lines[hitIdx]!;
  candidates.push(headline);
  for (let i = hitIdx + 1; i < Math.min(lines.length, hitIdx + 5); i++) candidates.push(lines[i]!);

  const kept: string[] = [];
  let charBudget = MAX_CHARS;
  for (const line of candidates) {
    if (kept.length >= MAX_LINES) break;
    if (FRAME_REGEX.test(line)) continue; // AC-A6: skip stack frames
    const projected = line.length + (kept.length > 0 ? 1 : 0); // +1 for newline
    if (projected > charBudget) break;
    kept.push(line);
    charBudget -= projected;
  }
  return kept.join('\n').slice(0, MAX_CHARS);
}

// =============================================================================
// Panic detection (AC-A6: headline surfaces in publicSummary regardless of reasonCode)
// =============================================================================

const PANIC_HEADLINE_REGEX = /thread\s+["'][^"']+["']\s+panicked at[^\n]*/i;

function extractPanicHeadline(rawText: string): string | null {
  const m = PANIC_HEADLINE_REGEX.exec(rawText);
  if (!m) return null;
  // Sanitize the headline (could embed a path like src/foo.rs:42:9)
  const sanitized = sanitizeCliStderr(m[0]).trim();
  // Cap to 200 chars to keep summary readable in error bubble
  return sanitized.slice(0, 200);
}

// =============================================================================
// Builder
// =============================================================================

/**
 * F212 AC-A7 / OQ-2: gate stderr log behind `LOG_CLI_STDERR=1` AND apply sanitizer.
 * Returns the sanitized + truncated string when caller SHOULD log, or null when gated off.
 *
 * Why a pure helper: lets us test "log/skip" decision without stubbing fastify/pino logger.
 * Callers (cli-spawn abnormal/timeout/success exit branches) use the same gate uniformly,
 * eliminating the 2026-05-26 P1-1 inconsistency where successful exit bypassed both gate and sanitizer.
 */
export function formatCliStderrForLog(stderrBuffer: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LOG_CLI_STDERR !== '1') return null;
  if (!stderrBuffer || !stderrBuffer.trim()) return null;
  return sanitizeCliStderr(stderrBuffer).slice(-1000);
}

export function buildCliDiagnostics(args: {
  rawText: string;
  debugRef: CliDiagnostics['debugRef'];
  /** F212 Phase D (AC-D3): CC structured result error message (errors[] / result fields from a
   *  Claude CLI result error event). Safe to surface even when reasonCode is unknown — it is
   *  CC's own standard wording, NOT raw stderr. */
  structuredErrorText?: string;
  /** F212 Phase F (AC-F4/F5): caller signals whether stderr was empty so we can pick the
   *  honest unknown-fallback hint (don't dangle LOG_CLI_STDERR=1 for empty-stderr cases).
   *  Omitted = legacy hint (backward-compat for callers not yet on Phase F contract). */
  stderrEmpty?: boolean;
}): CliDiagnostics {
  const reasonCode = classifyCliError(args.rawText);

  // AC-A6: panic headline takes precedence in summary (still keep reasonCode hint if known)
  const panicHeadline = extractPanicHeadline(args.rawText);

  // Known reasonCode → humanized text + whitelisted safeExcerpt (Phase A behavior).
  // Phase D P2 fix (cloud codex 2026-05-29): tag excerptSource='classifier' so the frontend
  // membership check (KNOWN_EXCERPT_SOURCES) admits this excerpt for disclosure rendering.
  if (reasonCode) {
    const baseText = REASON_TEXT[reasonCode];
    return {
      publicSummary: panicHeadline ? `CLI panic — ${panicHeadline}` : baseText.summary,
      publicHint: baseText.hint,
      debugRef: args.debugRef,
      reasonCode,
      safeExcerpt: extractSafeExcerpt(args.rawText, reasonCode),
      excerptSource: 'classifier',
    };
  }

  // AC-D3: unknown reasonCode, but CC emitted a structured result error → surface it so the user
  // sees "this is a Claude Code / model error" instead of the misleading "未识别" (which reads as
  // a Clowder AI bug). CC structured error is a safe source, so KD-1 admits its safeExcerpt even
  // without a classified reasonCode (whitelist via excerptSource channel, not reasonCode).
  // Phase D P2 fix (cloud codex 2026-05-29): tag excerptSource='cc_structured' so the frontend
  // KNOWN_EXCERPT_SOURCES membership check admits this for disclosure — previously the frontend's
  // reasonCode-only guard hid this excerpt and users only saw the 200-char publicSummary.
  if (args.structuredErrorText) {
    const sanitized = sanitizeCliStderr(args.structuredErrorText).trim();
    if (sanitized) {
      const headline =
        sanitized
          .split('\n')
          .find((l) => l.trim().length > 0)
          ?.slice(0, 200) ?? '';
      return {
        publicSummary: panicHeadline ? `CLI panic — ${panicHeadline}` : `Claude Code 报告：${headline}`,
        publicHint: '这是 Claude Code / 模型侧报告的错误，不是猫咖问题。展开看完整原因；可换一只猫或刷新对话重试。',
        debugRef: args.debugRef,
        safeExcerpt: sanitized.slice(0, MAX_CHARS),
        excerptSource: 'cc_structured',
      };
    }
  }

  // Truly unknown (no structured CC error).
  // #857: when rawText is available, sanitize + truncate and surface as safeExcerpt so
  // users see a desensitized message instead of having to check backend logs.
  // F212 Phase F (AC-F4/F5): pick honest unknown hint by stderrEmpty signal when caller
  // provides it; fall back to legacy hint for backward-compat (callers without Phase F awareness).
  let unknownHint: string = UNKNOWN_TEXT.hint;
  if (args.stderrEmpty === true) unknownHint = UNKNOWN_HINT_EMPTY_STDERR;
  else if (args.stderrEmpty === false) unknownHint = UNKNOWN_HINT_HAS_STDERR;

  const trimmedRaw = args.rawText?.trim();
  let safeExcerpt: string | undefined;
  let excerptSource: CliDiagnostics['excerptSource'] | undefined;
  if (trimmedRaw) {
    // R3 P1 fix (#857): sanitize + redact non-HOME paths. sanitizeCliStderr only
    // covers HOME/USERPROFILE/C:\Users/tmp; server installs under /srv, /workspace,
    // /var/lib, D:\work would leak raw paths without the extra redaction layer.
    safeExcerpt = redactNonHomePaths(sanitizeCliStderr(trimmedRaw)).slice(0, MAX_CHARS);
    excerptSource = 'unknown_raw';
  }

  return {
    publicSummary: panicHeadline ? `CLI panic — ${panicHeadline}` : UNKNOWN_TEXT.summary,
    publicHint: unknownHint,
    debugRef: args.debugRef,
    ...(safeExcerpt && { safeExcerpt, excerptSource }),
  };
}

// =============================================================================
// F212 Phase F — abnormal-exit structured diagnostic log payload (AC-F1, AC-F2)
// =============================================================================

/**
 * F212 Phase F (AC-F1): structured payload written on every abnormal CLI exit,
 * INDEPENDENT of `LOG_CLI_STDERR` env gate and INDEPENDENT of whether stderr is empty.
 *
 * Why: previously the cli-spawn abnormal exit branch only wrote `'CLI stderr ...'` log
 * when `formatCliStderrForLog(stderrBuffer)` returned non-null (i.e. env=1 AND stderr
 * non-empty). For the common Windows `codex.cmd exit 1 + empty stderr` case, this
 * produced ZERO log lines → users got `publicHint = '见后端日志（启用 LOG_CLI_STDERR=1）'`
 * but the log was always empty regardless. Dead-end UX (砚砚 cross thread 2026-05-30 catch).
 *
 * AC-F2 scope contract: `LOG_CLI_STDERR=1` env gate STILL controls only the raw/sanitized
 * stderr content field (handled separately by `formatCliStderrForLog`). This helper's
 * payload is unconditional — gate scope strictly does not bleed into the diagnostic log
 * decision.
 *
 * AC-F1 fields: every field is searchable by ops / users.
 *  - invocationId: lets users grep the log by the ID shown in the frontend debugRef
 *  - command / exitCode / signal: matches the user-facing diagnostic
 *  - reasonCode: links to the classified bucket (or null for unknown)
 *  - stderrEmpty: boolean so an alert can fire on "abnormal exit AND no stderr" (the
 *    case where users have nothing to grep)
 *  - streamErrorCount: F212 AC-A8 carrier — NDJSON stream errors are another channel
 *
 * NOTE: cwd is intentionally NOT in this payload (砚砚 R1 P1-2 + cloud codex R1 P2 双源
 * catch): sanitizeCliStderr only covers HOME-based paths, so non-HOME server installs
 * (/srv, /workspace, /var/lib, D:\work) would leak raw absolute paths. cwd is also
 * redundant with `command` (binary path conveys install context) + `invocationId`
 * (lookup via thread/session metadata). Do NOT add cwd back without a full safety review.
 */
export interface CliExitDiagnosticPayload {
  invocationId: string | null;
  command: string;
  exitCode: number | null;
  signal: string | null;
  reasonCode: CliErrorReasonCode | null;
  stderrEmpty: boolean;
  streamErrorCount: number;
}

export function buildCliExitDiagnostic(input: {
  invocationId?: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  reasonCode?: CliErrorReasonCode;
  stderrLength: number;
  streamErrorCount: number;
}): CliExitDiagnosticPayload {
  // P1-2 (砚砚 R1): cwd field deliberately omitted. The shared sanitizeCliStderr only
  // handles HOME / userProfile / C:\Users / /tmp paths — non-HOME server installs (/srv,
  // /workspace, /var/lib, D:\work) would leak raw absolute paths into the error log. Per
  // 砚砚 directive "无法证明安全就 omit"; cwd is also redundant with `command` (the binary
  // path usually conveys install location) + invocationId (lookup via thread/session metadata).
  return {
    invocationId: input.invocationId ?? null,
    command: input.command,
    exitCode: input.exitCode,
    signal: input.signal,
    reasonCode: input.reasonCode ?? null,
    stderrEmpty: input.stderrLength === 0,
    streamErrorCount: input.streamErrorCount,
  };
}

// =============================================================================
// F212 Phase G — silent_completion diagnostic builder (clowder-ai#875)
// =============================================================================

/**
 * Phase G (AC-G2): build a CliDiagnostics for the silent-stdout case — CLI exited
 * cleanly with event stream that has `eventCount > 0` but `textEventCount === 0`.
 * Surfaces evidence (event count + unique types + model + session prefix + exit +
 * stderr presence) so users get something actionable instead of generic
 * "completed without textual output" message.
 *
 * Safety invariants (mirror F212 Phase A KD-1 + Phase F AC-F5 safety):
 *  - sessionId truncated to first 8 chars only — never expose full session ID
 *  - eventTypes sorted + deduped + capped — clean bounded list, no order leak
 *  - stderrExcerpt optional and goes through sanitizeCliStderr if provided
 *  - debugRef stays small + plain — no prompt/body content embedded
 *
 * @param input - structured evidence collected by the provider stream loop
 * @returns CliDiagnostics with reasonCode = 'silent_completion'
 */
export function buildSilentCompletionDiagnostic(input: {
  /** Provider/CLI name (e.g. 'opencode', 'claude') — used in debugRef.command */
  command: string;
  /** Optional invocation context — same field as other F212 helpers */
  invocationId?: string;
  /** Total events received from the CLI stream */
  eventCount: number;
  /** Unique event type strings observed (e.g. ['step_start'] for the clowder-ai#875 case) */
  eventTypes: readonly string[];
  /** Model name if known (e.g. 'deepseek-chat') */
  model?: string;
  /** Full session id — will be truncated to first 8 chars before exposure */
  sessionId?: string;
  /** Process exit code. Defaults to 0 because silent_completion is only emitted after clean CLI exit. */
  exitCode?: number | null;
  /** Whether stderr buffer had any content (boolean, no raw stderr by default) */
  stderrPresent: boolean;
  /** Optional sanitized stderr excerpt (caller should pre-sanitize OR let helper do it) */
  stderrExcerpt?: string;
}): CliDiagnostics {
  const base = REASON_TEXT.silent_completion;
  // Safety: only first 8 chars of sessionId (CCID-style prefix), never the full ID
  const sessionIdPrefix = input.sessionId ? input.sessionId.slice(0, 8) : undefined;
  // Sort + dedupe event types for stable / clean exposure, then cap the evidence surface.
  // Cloud codex P2 (2026-06-09): event type strings come from NDJSON stream metadata and can be
  // numerous/long in malformed streams; cap count + item length before JSON-stringifying.
  const normalizedEventTypes = Array.from(
    new Set(input.eventTypes.map((type) => truncateEvidenceString(type, MAX_SILENT_EVENT_TYPE_CHARS)).filter(Boolean)),
  ).sort();
  const safeEventTypes = normalizedEventTypes.slice(0, MAX_SILENT_EVENT_TYPES);
  const eventTypesTruncated = normalizedEventTypes.length > safeEventTypes.length;
  const safeModel = input.model ? truncateEvidenceString(input.model, MAX_SILENT_MODEL_CHARS) : undefined;
  // Optional safeExcerpt: pre-sanitize through the shared sanitizer, then cap for the structured JSON budget.
  const safeStderrExcerpt = input.stderrExcerpt
    ? truncateSilentEvidenceString(input.stderrExcerpt, MAX_SILENT_STDERR_CHARS)
    : undefined;
  const evidence = {
    eventCount: input.eventCount,
    eventTypes: safeEventTypes,
    ...(eventTypesTruncated ? { eventTypeCount: normalizedEventTypes.length, eventTypesTruncated: true } : {}),
    ...(safeModel ? { model: safeModel } : {}),
    ...(sessionIdPrefix ? { sessionIdPrefix } : {}),
    stderrPresent: input.stderrPresent,
    ...(safeStderrExcerpt ? { stderrExcerpt: safeStderrExcerpt } : {}),
  };
  const safeExcerpt = JSON.stringify(evidence, null, 2);

  return {
    reasonCode: 'silent_completion',
    publicSummary: base.summary,
    publicHint: base.hint,
    debugRef: {
      command: input.command,
      // Cloud codex P2 (2026-06-08): silent_completion is a clean-exit path.
      // Non-zero exits already surface as __cliError before this builder is used.
      exitCode: input.exitCode ?? 0,
      signal: null,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    },
    // safeExcerpt slot holds the structured evidence (JSON-stringified — frontend renders
    // as raw text in disclosure section). KD-1: this is admitted because the content is
    // self-built (no raw stderr), sessionId is truncated, model + types + counts are
    // metadata not user data.
    safeExcerpt:
      safeExcerpt.length <= MAX_CHARS
        ? safeExcerpt
        : JSON.stringify(
            {
              eventCount: input.eventCount,
              eventTypes: safeEventTypes.slice(0, 3),
              eventTypeCount: normalizedEventTypes.length,
              eventTypesTruncated: true,
              stderrPresent: input.stderrPresent,
            },
            null,
            2,
          ),
    // Self-built structured payload — safe like Phase D's 'cc_structured' channel
    excerptSource: 'cc_structured',
  };
}
