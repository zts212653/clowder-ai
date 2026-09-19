import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PRECOMPACT_COMMAND = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/f24-pre-compact.sh';
const PORTABLE_PRECOMPACT_COMMAND = `"${process.execPath.replaceAll('\\', '/')}" ".claude/hooks/f24-compaction.mjs" pre`;
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

function isPortablePreCompactCommand(command: string): boolean {
  const match = /^"([^"\r\n]+)" "\.claude\/hooks\/f24-compaction\.mjs" pre$/.exec(command);
  if (!match?.[1] || !isAbsolute(match[1])) return false;
  try {
    // Windows preserves launcher spelling in execPath. Compare the actual Node
    // file, while keeping the script, arguments and synchronous hook contract exact.
    return realpathSync.native(match[1]) === realpathSync.native(process.execPath);
  } catch {
    return false;
  }
}

function hasCanonicalPreCompactCommand(settings: unknown, command = PRECOMPACT_COMMAND): boolean {
  if (!isRecord(settings)) return false;
  if (settings.disableAllHooks === true) return false;
  if (!isRecord(settings.hooks)) return false;
  if (!Array.isArray(settings.hooks.PreCompact)) return false;

  return settings.hooks.PreCompact.some((entry) => {
    if (!isRecord(entry)) return false;
    if (command === PORTABLE_PRECOMPACT_COMMAND && entry.matcher !== 'manual|auto') return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === 'command' &&
        hook.async !== true &&
        typeof hook.command === 'string' &&
        (command === PORTABLE_PRECOMPACT_COMMAND
          ? isPortablePreCompactCommand(hook.command.trim())
          : hook.command.trim() === command),
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
    const localPath = join(projectRoot, '.claude', 'settings.local.json');
    if (existsSync(localPath)) {
      const local = JSON.parse(readFileSync(localPath, 'utf8')) as unknown;
      if (!isRecord(local) || local.disableAllHooks === true) return false;
    }
    if (hasCanonicalPreCompactCommand(settings, PORTABLE_PRECOMPACT_COMMAND)) {
      const portablePath = join(projectRoot, '.claude', 'hooks', 'f24-compaction.mjs');
      const stat = lstatSync(portablePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      // Node executes a readable script on Windows; POSIX execute bits do not
      // describe this carrier. Invocation authentication/attestation remain mandatory.
      const source = readFileSync(portablePath, 'utf8');
      return (
        !source.includes('CAT_CAFE_HOOK_TOKEN') && REQUIRED_CALLBACK_MARKERS.every((marker) => source.includes(marker))
      );
    }
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
