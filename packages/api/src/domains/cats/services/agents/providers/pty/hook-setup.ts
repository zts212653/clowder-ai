/**
 * F230 B-hook: Hook infrastructure setup
 *
 * Creates the `.claude/settings.json` + capture script in a PTY cwd so
 * that Claude's Stop and PostToolUse hooks funnel structured JSON into a
 * sidecar jsonl file. The sidecar is then tailed by TranscriptTailer in
 * the carrier's output loop.
 *
 * Design:
 * - Capture script is POSIX sh (no bash/node dependency, instant start)
 * - Script reads stdin (hook event JSON), appends one line to $CAT_CAFE_HOOK_SIDECAR
 * - Settings are scoped to cwd (`.claude/settings.json`), zero global pollution
 * - Cleanup restores original settings or removes if none existed
 * - Empty sidecar file created upfront so tailer can start immediately
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HookInfrastructureResult {
  /** Path to .claude/settings.json */
  settingsPath: string;
  /** Path to the capture script */
  scriptPath: string;
  /** Restore original settings or remove if none existed */
  cleanup: () => Promise<void>;
}

/**
 * Set up hook infrastructure in the given cwd:
 * 1. Write capture script to cwd/.claude/ (reads stdin → appends to sidecar)
 * 2. Write .claude/settings.json with Stop + PostToolUse hooks
 * 3. Create empty sidecar file for TranscriptTailer
 *
 * @param cwd Working directory for the PTY session
 * @param sidecarPath Absolute path to the sidecar jsonl file
 */
export async function setupHookInfrastructure(cwd: string, sidecarPath: string): Promise<HookInfrastructureResult> {
  const claudeDir = join(cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  const scriptPath = join(claudeDir, 'hook-capture.sh');

  // Backup existing settings for restore on cleanup
  const hadExistingSettings = existsSync(settingsPath);
  const originalSettings = hadExistingSettings ? readFileSync(settingsPath, 'utf8') : undefined;

  // Write capture script — POSIX sh, reads stdin, appends to sidecar
  // The script receives the hook event JSON on stdin and must append it
  // as a single line to the sidecar jsonl file.
  // F230 follow-up ①: enrich with CLAUDE_CODE_ENTRYPOINT env var (AC-B1
  // billing identity guard). Claude sets this to 'cli' for interactive
  // mode — injecting it into the sidecar JSON lets the carrier surface
  // it in done.metadata as file-level evidence of subscription billing.
  const captureScript = `#!/bin/sh
# F230 B-hook capture script — reads hook event JSON from stdin,
# enriches with CLAUDE_CODE_ENTRYPOINT env (AC-B1 billing identity),
# appends to sidecar jsonl. POSIX sh for zero-dependency instant start.
# CAT_CAFE_HOOK_SIDECAR env var set by PtyDriver.
input=$(cat)
if [ -n "$input" ] && [ -n "$CAT_CAFE_HOOK_SIDECAR" ]; then
  if [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
    input=$(printf '%s' "$input" | sed 's/}$/,"_cc_entrypoint":"'"$CLAUDE_CODE_ENTRYPOINT"'"}/')
  fi
  printf '%s\\n' "$input" >> "$CAT_CAFE_HOOK_SIDECAR"
fi
`;
  writeFileSync(scriptPath, captureScript, 'utf8');
  chmodSync(scriptPath, 0o755);

  // Write settings.json with hook configuration.
  // Claude's hook schema: hooks.<EventName> = Array<{ hooks: Array<{ type, command, timeout? }> }>
  // Each event maps to an array of hook groups, each group has a `hooks` array of entries.
  // Format verified against ~/.claude/settings.json (global hooks use this exact schema).
  const hookEntry = (cmd: string) => ({
    hooks: [{ type: 'command' as const, command: cmd, timeout: 5000 }],
  });
  const settings = {
    hooks: {
      Stop: [hookEntry(scriptPath)],
      PostToolUse: [hookEntry(scriptPath)],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  // Create empty sidecar file so TranscriptTailer can start immediately
  writeFileSync(sidecarPath, '', 'utf8');

  const cleanup = async () => {
    // Restore or remove settings
    if (originalSettings != null) {
      writeFileSync(settingsPath, originalSettings, 'utf8');
    } else {
      try {
        rmSync(settingsPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    // Remove capture script
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  };

  return { settingsPath, scriptPath, cleanup };
}
