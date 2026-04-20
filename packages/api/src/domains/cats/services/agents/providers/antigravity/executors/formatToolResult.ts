import type { ExecutorResult } from './AntigravityToolExecutor.js';

const TOOL_RESULT_MAX_CHARS = 4096;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const truncated = s.slice(0, max);
  return `${truncated}\n…[truncated ${s.length - max} chars]`;
}

export function formatToolResult(
  input: { commandLine: string; cwd?: string },
  result: ExecutorResult<unknown>,
): string {
  const header = `[native-executor result for: ${input.commandLine}]`;
  if (result.status === 'refused') {
    return `${header}\n\nStatus: refused\nReason: ${result.reason}\n\nPlease choose a different approach.`;
  }
  if (result.status === 'error') {
    return `${header}\n\nStatus: error\nError: ${truncate(result.error, 1024)}\nDuration: ${result.durationMs}ms`;
  }
  const parts = [
    header,
    '',
    `Status: success`,
    `Exit code: ${result.exitCode ?? 0}`,
    `Duration: ${result.durationMs}ms`,
  ];
  if (result.stdout && result.stdout.length > 0) {
    parts.push('', '--- stdout ---', truncate(result.stdout, TOOL_RESULT_MAX_CHARS));
  }
  if (result.stderr && result.stderr.length > 0) {
    parts.push('', '--- stderr ---', truncate(result.stderr, TOOL_RESULT_MAX_CHARS / 2));
  }
  return parts.join('\n');
}
