import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_NATIVE_GUARD_HOOK_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';
const MATCHER = 'Bash|Edit|Write';
const TIMEOUT_SECONDS = 5;
const STATUS_MESSAGE = 'Checking protected effects…';

export function buildCodexNativeEffectGuardArgs(options?: {
  readonly repoRoot?: string;
  readonly nodeExecutable?: string;
}): string[] {
  const repoRoot = options?.repoRoot ?? resolveRepositoryRoot();
  const scriptPath = join(repoRoot, 'scripts', 'native-effect-target-guard.mjs');
  if (!existsSync(scriptPath)) throw new Error(`native_effect_guard_missing:${scriptPath}`);
  const command = `${shellQuote(options?.nodeExecutable ?? process.execPath)} ${shellQuote(realpathSync(scriptPath))}`;
  const trustedHash = hookHash(command);
  const hookConfig = [
    'hooks={',
    `PreToolUse=[{matcher=${tomlString(MATCHER)},hooks=[{type="command",command=${tomlString(command)},timeout=${TIMEOUT_SECONDS},statusMessage=${tomlString(STATUS_MESSAGE)}}]}],`,
    `state={${tomlString(CODEX_NATIVE_GUARD_HOOK_KEY)}={enabled=true,trusted_hash=${tomlString(trustedHash)}}}`,
    '}',
  ].join('');
  return ['--config', 'features.hooks=true', '--config', hookConfig];
}

export function nativeEffectGuardHookHash(command: string): string {
  return hookHash(command);
}

function hookHash(command: string): string {
  const identity = {
    event_name: 'pre_tool_use',
    hooks: [
      {
        async: false,
        command,
        statusMessage: STATUS_MESSAGE,
        timeout: TIMEOUT_SECONDS,
        type: 'command',
      },
    ],
    matcher: MATCHER,
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalJson(identity)))
    .digest('hex')}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function resolveRepositoryRoot(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) cursor = dirname(cursor);
  return cursor;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
