/**
 * CLI Exit Error Formatting
 * 三只猫共享的 CLI 退出错误格式化工具
 *
 * Note: Uses sanitized `message` field — raw stderr is never exposed to users.
 */

/**
 * Format a CLI exit event into a human-readable error string.
 * @param cliName Display name of the CLI (e.g. "Claude CLI", "Codex CLI")
 * @param event Exit details from spawnCli (message is pre-sanitized, no raw stderr)
 */
export function formatCliExitError(
  cliName: string,
  event: { exitCode: number | null; signal: string | null; message: string; reasonCode?: string },
): string {
  // Use the pre-sanitized message from cli-spawn (no raw stderr exposure)
  const base = `${cliName}: ${event.message}`;
  return event.reasonCode ? `${base} [${event.reasonCode}]` : base;
}
