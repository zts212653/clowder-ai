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
};

const UNKNOWN_TEXT = {
  summary: '未识别的 CLI 错误',
  hint: '详细诊断信息见后端日志（启用：环境变量 LOG_CLI_STDERR=1）。',
};

// =============================================================================
// safeExcerpt extraction (KD-2: sanitize first, slice after)
// =============================================================================

const MAX_LINES = 8;
const MAX_CHARS = 1500;
/** AC-A6: stack frame patterns — rust frame numbers / `at <file>` / cargo / node_modules */
const FRAME_REGEX = /^\s*\d+:\s|^\s*at\s/;

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

  // Truly unknown (no structured CC error) — keep KD-1: no safeExcerpt.
  return {
    publicSummary: panicHeadline ? `CLI panic — ${panicHeadline}` : UNKNOWN_TEXT.summary,
    publicHint: UNKNOWN_TEXT.hint,
    debugRef: args.debugRef,
  };
}
