import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HealthResult } from './health.js';

type JsonObject = Record<string, unknown>;

const MANAGED_HOOKS = {
  SessionStart: 'session-start-recall.sh',
  Stop: 'session-stop-check.sh',
} as const;

const MANAGED_HOOK_NAMES = new Set<string>(Object.values(MANAGED_HOOKS));

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectedClaudeCommand(targetRoot: string, eventName: keyof typeof MANAGED_HOOKS): string {
  return join(targetRoot, '.claude', 'hooks', MANAGED_HOOKS[eventName]);
}

function stripWrappingShellQuotes(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? trimmed.slice(1, -1) : trimmed;
}

function normalizeHookCommand(command: unknown, targetRoot: string): string | null {
  if (typeof command !== 'string') return null;
  const unquoted = stripWrappingShellQuotes(command);
  const expanded = unquoted.startsWith('$HOME/')
    ? join(targetRoot, unquoted.slice('$HOME/'.length))
    : unquoted.startsWith('${HOME}/')
      ? join(targetRoot, unquoted.slice('${HOME}/'.length))
      : unquoted.startsWith('~/')
        ? join(targetRoot, unquoted.slice('~/'.length))
        : unquoted;
  return expanded.replace(/\\/g, '/');
}

function commandBasename(command: unknown, targetRoot: string): string | null {
  const normalized = normalizeHookCommand(command, targetRoot);
  if (normalized === null) return null;
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isManagedHookCommand(command: unknown, targetRoot: string): boolean {
  const normalized = normalizeHookCommand(command, targetRoot);
  if (normalized === null) return false;
  const managedDir = join(targetRoot, '.claude', 'hooks').replace(/\\/g, '/');
  if (!normalized.startsWith(`${managedDir}/`)) return false;
  const basename = commandBasename(command, targetRoot);
  return basename !== null && MANAGED_HOOK_NAMES.has(basename);
}

function eventEntries(settings: JsonObject, eventName: string): JsonObject[] {
  const hooksRoot = settings.hooks;
  if (!isJsonObject(hooksRoot)) return [];
  const entries = (hooksRoot as JsonObject)[eventName];
  return Array.isArray(entries) ? (entries.filter((entry) => entry && typeof entry === 'object') as JsonObject[]) : [];
}

function entryHooks(entry: JsonObject): JsonObject[] {
  return Array.isArray(entry.hooks)
    ? (entry.hooks.filter((hook) => hook && typeof hook === 'object') as JsonObject[])
    : [];
}

function eventHasCommand(
  settings: JsonObject,
  eventName: keyof typeof MANAGED_HOOKS,
  command: string,
  targetRoot: string,
): boolean {
  const expected = normalizeHookCommand(command, targetRoot);
  return eventEntries(settings, eventName).some((entry) =>
    entryHooks(entry).some(
      (hook) => hook.type === 'command' && normalizeHookCommand(hook.command, targetRoot) === expected,
    ),
  );
}

function eventHasStaleManagedCommand(
  settings: JsonObject,
  eventName: keyof typeof MANAGED_HOOKS,
  expected: string,
  targetRoot: string,
): boolean {
  const expectedCommand = normalizeHookCommand(expected, targetRoot);
  return eventEntries(settings, eventName).some((entry) =>
    entryHooks(entry).some(
      (hook) =>
        hook.type === 'command' &&
        isManagedHookCommand(hook.command, targetRoot) &&
        normalizeHookCommand(hook.command, targetRoot) !== expectedCommand,
    ),
  );
}

function readJsonObject(path: string): JsonObject {
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  if (!isJsonObject(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

export function claudeSettingsHealth(targetRoot: string): HealthResult {
  const targetPath = join(targetRoot, '.claude', 'settings.json');
  if (!existsSync(targetPath)) {
    return {
      name: 'claude-settings',
      drifted: true,
      status: 'missing',
      targetPath,
      reason: 'Claude settings.json does not exist',
      diff: { kind: 'json', message: 'target file is missing' },
    };
  }

  try {
    const settings = readJsonObject(targetPath);
    const startCommand = expectedClaudeCommand(targetRoot, 'SessionStart');
    const stopCommand = expectedClaudeCommand(targetRoot, 'Stop');
    const hasStart = eventHasCommand(settings, 'SessionStart', startCommand, targetRoot);
    const hasStop = eventHasCommand(settings, 'Stop', stopCommand, targetRoot);
    if (hasStart && hasStop) {
      return { name: 'claude-settings', drifted: false, status: 'configured', targetPath, reason: 'configured' };
    }
    if (
      eventHasStaleManagedCommand(settings, 'SessionStart', startCommand, targetRoot) ||
      eventHasStaleManagedCommand(settings, 'Stop', stopCommand, targetRoot)
    ) {
      return {
        name: 'claude-settings',
        drifted: true,
        status: 'stale',
        targetPath,
        reason: 'Claude settings has stale managed hook command entries',
        diff: { kind: 'json', message: 'managed SessionStart/Stop command differs', fields: ['hooks'] },
      };
    }
    return {
      name: 'claude-settings',
      drifted: true,
      status: 'missing',
      targetPath,
      reason: 'Claude settings is missing managed SessionStart/Stop hook entries',
      diff: { kind: 'json', message: 'managed SessionStart/Stop hook entries are missing', fields: ['hooks'] },
    };
  } catch (error) {
    return {
      name: 'claude-settings',
      drifted: false,
      status: 'error',
      targetPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readOptionalSettings(targetPath: string): JsonObject {
  if (!existsSync(targetPath)) return {};
  return readJsonObject(targetPath);
}

function withoutManagedHooks(entries: JsonObject[], targetRoot: string): JsonObject[] {
  return entries.flatMap((entry) => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entryHooks(entry).filter((hook) => !isManagedHookCommand(hook.command, targetRoot));
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
}

export async function syncClaudeSettings(targetRoot: string): Promise<void> {
  const targetPath = join(targetRoot, '.claude', 'settings.json');
  const settings = readOptionalSettings(targetPath);
  const hooksRoot: JsonObject =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as JsonObject)
      : {};

  for (const eventName of Object.keys(MANAGED_HOOKS) as Array<keyof typeof MANAGED_HOOKS>) {
    const entries = withoutManagedHooks(eventEntries(settings, eventName), targetRoot);
    entries.push({ hooks: [{ type: 'command', command: expectedClaudeCommand(targetRoot, eventName) }] });
    hooksRoot[eventName] = entries;
  }

  settings.hooks = hooksRoot;
  await mkdir(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}
