/**
 * Antigravity CLI plain-text parser.
 *
 * AGY 1.0.1 print mode does not expose Gemini-compatible NDJSON. It returns
 * final stdout text, while some provider failures are also plain text/log lines.
 */

export type AntigravityCliPlainTextResult =
  | { kind: 'text'; content: string; textMode?: 'replace' }
  | { kind: 'error'; errorKind: 'timeout' | 'missing_model'; error: string }
  | { kind: 'empty' };

export interface AntigravityCliPlainTextInput {
  stdout: string;
  stderr?: string;
  resumed?: boolean;
}

export function classifyAntigravityCliPlainText(input: AntigravityCliPlainTextInput): AntigravityCliPlainTextResult {
  const trimmedStdout = stripFreshConversationWarning(input.stdout).trim();
  const diagnosticText = `${trimmedStdout}\n${(input.stderr ?? '').trim()}`;

  if (isAgyPrintTimeoutOutput(trimmedStdout)) {
    return {
      kind: 'error',
      errorKind: 'timeout',
      error: 'Antigravity CLI 响应超时：agy --print-timeout 返回了 timeout 文本但进程可能仍是 exit 0。',
    };
  }

  if (isAgyMissingModelDiagnostic(diagnosticText)) {
    return {
      kind: 'error',
      errorKind: 'missing_model',
      error: formatAgyMissingModelError(),
    };
  }

  if (trimmedStdout.length === 0) {
    return { kind: 'empty' };
  }

  return input.resumed
    ? { kind: 'text', content: trimmedStdout, textMode: 'replace' }
    : { kind: 'text', content: trimmedStdout };
}

function isAgyPrintTimeoutOutput(stdout: string): boolean {
  return /^Error:\s*timed out waiting for response\.?$/i.test(stdout.trim());
}

function stripFreshConversationWarning(stdout: string): string {
  return stdout.replace(/^Warning:\s*conversation\s+"agy-[^"\r\n]+"\s+not found\.\r?\n/i, '');
}

function isAgyMissingModelDiagnostic(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:Error:|E\.\.\.)\s*(?:failed to construct executor:\s*)?neither PlanModel nor RequestedModel specified\b/im.test(
      trimmed,
    ) || /^(?:Error:|E\.\.\.).*\bPlease use the \/model command\b/im.test(trimmed)
  );
}

function formatAgyMissingModelError(): string {
  return [
    'Antigravity CLI 没有可用的账号侧默认模型。',
    'AGY CLI 1.0.1 没有已验证的 --model/env per-call 模型覆盖；请先运行 `agy` 进入交互模式，用 `/model` 选择默认模型后再重试。',
  ].join(' ');
}
