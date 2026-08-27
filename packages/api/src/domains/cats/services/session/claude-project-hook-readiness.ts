import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRECOMPACT_COMMAND = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/f24-pre-compact.sh';
const REQUIRED_CALLBACK_MARKERS = [
  '/api/sessions/seal',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'X-Invocation-Id',
  'X-Callback-Token',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCanonicalPreCompactCommand(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  if (!isRecord(settings.hooks)) return false;
  if (!Array.isArray(settings.hooks.PreCompact)) return false;

  return settings.hooks.PreCompact.some((entry) => {
    if (!isRecord(entry)) return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === 'command' &&
        typeof hook.command === 'string' &&
        hook.command.trim() === PRECOMPACT_COMMAND,
    );
  });
}

/**
 * Proves the project-local half of Claude compaction authority for one active
 * invocation workspace. Callback-registry recovery is a separate coordinate.
 */
export function isClaudeProjectHookCarrierReady(projectRoot: string | undefined): boolean {
  if (!projectRoot) return false;

  try {
    const settings = JSON.parse(readFileSync(join(projectRoot, '.claude', 'settings.json'), 'utf8')) as unknown;
    if (!hasCanonicalPreCompactCommand(settings)) return false;

    const hookPath = join(projectRoot, '.claude', 'hooks', 'f24-pre-compact.sh');
    const hookStat = lstatSync(hookPath);
    const isExecutableProjectFile = hookStat.isFile() && !hookStat.isSymbolicLink() && (hookStat.mode & 0o111) !== 0;
    if (!isExecutableProjectFile) return false;

    const hookSource = readFileSync(hookPath, 'utf8');
    return (
      !hookSource.includes('CAT_CAFE_HOOK_TOKEN') &&
      REQUIRED_CALLBACK_MARKERS.every((marker) => hookSource.includes(marker))
    );
  } catch {
    return false;
  }
}
