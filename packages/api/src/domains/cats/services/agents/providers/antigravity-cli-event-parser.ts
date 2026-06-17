/**
 * Antigravity CLI plain-text parser.
 *
 * AGY print mode does not expose Gemini-compatible NDJSON. It returns
 * final stdout text, while some provider failures are also plain text/log lines.
 */

export type AntigravityCliPlainTextResult =
  | { kind: 'text'; content: string; textMode?: 'replace' }
  | { kind: 'error'; errorKind: 'timeout' | 'missing_model' | 'missing_session' | 'auth_required'; error: string }
  | { kind: 'empty' };

export interface AntigravityCliPlainTextInput {
  stdout: string;
  stderr?: string;
  resumed?: boolean;
  agyLogText?: string;
  /**
   * F210 H2b: resumed turn 从 trajectory SQLite 提取的本轮 final answer text。
   * 非空时**替换** stdout 重放（根治 `agy --print --conversation` 累加重放 `[1]→[1,2]→[1,2,3]`）；
   * 空 / 缺省 / 提取失败时保留现有 stdout（fail-open，绝不输出截断/错误回复）。
   */
  resumedFinalText?: string | null;
}

export function classifyAntigravityCliPlainText(input: AntigravityCliPlainTextInput): AntigravityCliPlainTextResult {
  const missingConversationId = input.resumed
    ? (extractAgyConversationNotFoundWarning(input.stdout) ??
      extractAgyConversationNotFoundWarning(input.agyLogText ?? ''))
    : null;
  if (input.resumed && missingConversationId) {
    return {
      kind: 'error',
      errorKind: 'missing_session',
      error: `No conversation found with session ID: ${missingConversationId}`,
    };
  }

  const trimmedStdout = stripFreshConversationWarning(input.stdout).trim();
  const diagnosticText = `${trimmedStdout}\n${(input.stderr ?? '').trim()}`;

  if (isAgyPrintTimeoutOutput(trimmedStdout)) {
    return {
      kind: 'error',
      errorKind: 'timeout',
      error: 'Antigravity CLI 响应超时：agy --print-timeout 返回了 timeout 文本但进程可能仍是 exit 0。',
    };
  }

  if (isAgyAuthRequiredDiagnostic(diagnosticText)) {
    return {
      kind: 'error',
      errorKind: 'auth_required',
      error: formatAgyAuthRequiredError(),
    };
  }

  if (isAgyMissingModelDiagnostic(diagnosticText)) {
    return {
      kind: 'error',
      errorKind: 'missing_model',
      error: formatAgyMissingModelError(),
    };
  }

  const resumedFinalText = input.resumed ? input.resumedFinalText?.trim() : undefined;
  const hasResumedFinal = Boolean(resumedFinalText && resumedFinalText.length > 0);

  if (trimmedStdout.length === 0) {
    // F210 H2b (云端 codex P2): resumed turn stdout 为空但 trajectory 提取到有效 final →
    // 用 final（不当 empty 丢弃有效回复）；非 resumed / 无 final → empty。
    if (hasResumedFinal) {
      return { kind: 'text', content: resumedFinalText as string, textMode: 'replace' };
    }
    return { kind: 'empty' };
  }

  if (input.resumed) {
    // F210 H2b: trajectory 提取到本轮 final answer → 替换 stdout 重放；否则 fail-open 保留 stdout。
    return {
      kind: 'text',
      content: hasResumedFinal ? (resumedFinalText as string) : trimmedStdout,
      textMode: 'replace',
    };
  }
  return { kind: 'text', content: trimmedStdout };
}

export function extractAntigravityCliConversationId(logText: string): string | null {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const re = new RegExp(
    `(?:Created conversation|Print mode: conversation=|Streaming conversation|Sending user message to conversation|Forwarding user message to conversation)\\s*(${uuid})`,
    'gi',
  );
  let conversationId: string | null = null;
  for (const match of logText.matchAll(re)) {
    conversationId = match[1] ?? conversationId;
  }
  return conversationId;
}

export function extractAntigravityCliSelectedModelLabel(logText: string): string | null {
  const re = /\bPropagating selected model override to backend:\s*label="([^"\r\n]+)"/gi;
  let selectedModel: string | null = null;
  for (const match of logText.matchAll(re)) {
    selectedModel = match[1] ?? selectedModel;
  }
  return selectedModel;
}

function isAgyPrintTimeoutOutput(stdout: string): boolean {
  return /^Error:\s*timed out waiting for response\.?$/i.test(stdout.trim());
}

function stripFreshConversationWarning(stdout: string): string {
  return stdout.replace(/^Warning:\s*conversation\s+"agy-[^"\r\n]+"\s+not found\.\r?\n/i, '');
}

function extractAgyConversationNotFoundWarning(stdout: string): string | null {
  const stdoutMatch = stdout.match(/^Warning:\s*conversation\s+"([^"\r\n]+)"\s+not found\./im);
  if (stdoutMatch?.[1]) return stdoutMatch[1];

  const logMatch = stdout.match(/\bConversation\s+([^\s,]+)\s+not found,\s+ignoring\s+--conversation\s+flag\b/i);
  return logMatch?.[1] ?? null;
}

function isAgyMissingModelDiagnostic(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:Error:|E\.\.\.)\s*(?:failed to construct executor:\s*)?neither PlanModel nor RequestedModel specified\b/im.test(
      trimmed,
    ) || /^(?:Error:|E\.\.\.).*\bPlease use the \/model command\b/im.test(trimmed)
  );
}

function isAgyAuthRequiredDiagnostic(text: string): boolean {
  const trimmed = text.trim();
  const hasAuthPrompt = /^Authentication required\.\s+Please visit the URL to log in:/im.test(trimmed);
  const hasGoogleOAuthUrl = /^\s*https:\/\/accounts\.google\.com\/o\/oauth2\/auth\b/im.test(trimmed);
  const hasAuthWait = /^Waiting for authentication \(timeout \d+s\)\.\.\./im.test(trimmed);
  const hasAuthInterrupted = /^Error:\s*authentication interrupted\.?$/im.test(trimmed);

  return hasAuthPrompt && (hasGoogleOAuthUrl || (hasAuthWait && hasAuthInterrupted));
}

function formatAgyAuthRequiredError(): string {
  return [
    'Antigravity CLI profile is not authenticated.',
    'Run `agy` with the same HOME/profile and complete login before unattended Clowder AI use.',
    'For isolated AGY profiles, each profile HOME must be onboarded separately.',
  ].join(' ');
}

function formatAgyMissingModelError(): string {
  return [
    'Antigravity CLI 没有可用的账号侧默认模型。',
    'AGY CLI 没有已验证的 --model/env per-call 模型覆盖；请先运行 `agy` 进入交互模式，用 `/model` 选择默认模型后再重试。',
  ].join(' ');
}
