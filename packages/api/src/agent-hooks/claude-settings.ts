import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HealthResult } from './health.js';
import { HOOK_LOAD_CONTRACTS } from './hook-load-contracts.js';
import {
  inspectManagedHooks,
  mergeManagedHooks,
  readHookDocument,
  renderManagedHooksDocument,
} from './managed-hook-entries.js';
import { managedHookCommands, type SyncOutcome } from './sync-targets.js';

const NAME = 'claude-settings';

function settingsPath(targetRoot: string): string {
  return join(targetRoot, '.claude', 'settings.json');
}

function scope(targetRoot: string) {
  return { targetRoot, commands: managedHookCommands('claude', targetRoot), contract: HOOK_LOAD_CONTRACTS.claude };
}

function stale(targetPath: string, reason: string, message: string): HealthResult {
  return {
    name: NAME,
    drifted: true,
    status: 'stale',
    targetPath,
    reason,
    diff: { kind: 'json', message, fields: ['hooks'] },
  };
}

export function claudeSettingsHealth(targetRoot: string): HealthResult {
  const targetPath = settingsPath(targetRoot);
  if (!existsSync(targetPath)) {
    return {
      name: NAME,
      drifted: true,
      status: 'missing',
      targetPath,
      reason: 'Claude settings.json does not exist',
      diff: { kind: 'json', message: 'target file is missing' },
    };
  }

  const read = readHookDocument(targetPath);
  const inspection = read.ok ? inspectManagedHooks(read.source, scope(targetRoot)) : undefined;
  const invalid = read.ok ? inspection?.invalid : read.reason;
  if (invalid !== undefined || !inspection) {
    return { name: NAME, drifted: false, status: 'error', targetPath, reason: invalid ?? 'unreadable Claude settings' };
  }
  if (inspection.missingBash) {
    return stale(
      targetPath,
      'Claude settings hook commands missing bash prefix for cross-platform support',
      'managed hook commands need bash prefix',
    );
  }
  if (inspection.duplicated.length > 0 || inspection.outdated.length > 0) {
    return stale(
      targetPath,
      'Claude settings has stale managed hook command entries',
      'managed SessionStart/Stop command differs',
    );
  }
  if (inspection.missing.length > 0) {
    return {
      name: NAME,
      drifted: true,
      status: 'missing',
      targetPath,
      reason: 'Claude settings is missing managed SessionStart/Stop hook entries',
      diff: { kind: 'json', message: 'managed SessionStart/Stop hook entries are missing', fields: ['hooks'] },
    };
  }
  return { name: NAME, drifted: false, status: 'configured', targetPath, reason: 'configured' };
}

/**
 * Adds or updates only the Clowder-managed SessionStart/Stop entries. Every other setting and
 * hook is preserved; an unreadable or structurally unexpected file is left untouched (#1566).
 */
export async function syncClaudeSettings(targetRoot: string): Promise<SyncOutcome> {
  const targetPath = settingsPath(targetRoot);
  const outcome = (action: SyncOutcome['action'], reason?: string): SyncOutcome => ({
    name: NAME,
    targetPath,
    action,
    ...(reason ? { reason } : {}),
  });
  if (!existsSync(targetPath)) {
    await mkdir(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, renderManagedHooksDocument(scope(targetRoot).commands), 'utf-8');
    return outcome('written');
  }
  const read = readHookDocument(targetPath);
  const result = read.ok
    ? mergeManagedHooks(read.source, { ...scope(targetRoot), removeDuplicates: true })
    : ({ kind: 'refused', reason: read.reason } as const);
  if (result.kind === 'refused') {
    console.warn(`skipped ${NAME}: ${result.reason} (${targetPath} left unchanged)`);
    return outcome('refused', result.reason);
  }
  if (result.kind === 'unchanged') return outcome('unchanged');

  // writeFileSync follows symlinks, so dotfile-managed settings stay links.
  writeFileSync(targetPath, result.text, 'utf-8');
  return outcome('written');
}
