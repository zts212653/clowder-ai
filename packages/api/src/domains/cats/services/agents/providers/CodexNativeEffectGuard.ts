import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { secretRuntimeRoot } from '@cat-cafe/mcp-server/dist/secret-runtime.js';

export const CODEX_NATIVE_GUARD_HOOK_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0';
export const CODEX_NATIVE_SHELL_GUARD_HOOK_KEY = '/<session-flags>/config.toml:native_shell_safety_check:0:0';
const MATCHER = 'Bash|Edit|Write';
const TIMEOUT_SECONDS = 5;
const STATUS_MESSAGE = 'Checking protected effects…';

export function buildCodexNativeEffectGuardArgs(options?: {
  readonly repoRoot?: string;
  readonly nodeExecutable?: string;
  /** Only selected after the AgentService verifies the reviewed executor artifact. */
  readonly nativeShellSafetyCheck?: boolean;
}): string[] {
  const repoRoot = options?.repoRoot ?? resolveRepositoryRoot();
  const scriptPath = join(repoRoot, 'scripts', 'native-effect-target-guard.mjs');
  if (!existsSync(scriptPath)) throw new Error(`native_effect_guard_missing:${scriptPath}`);
  const command = `${shellQuote(options?.nodeExecutable ?? process.execPath)} ${shellQuote(realpathSync(scriptPath))}`;
  const secretScript = join(repoRoot, 'scripts', 'secret-native-hook.mjs');
  if (!existsSync(secretScript)) throw new Error('secret_native_hook_unavailable');
  const secretCommand = `${shellQuote(options?.nodeExecutable ?? process.execPath)} ${shellQuote(realpathSync(secretScript))}`;
  const effectGroups = options?.nativeShellSafetyCheck
    ? [
        { event: 'PreToolUse', key: 'pre_tool_use', matcher: 'Edit|Write' },
        { event: 'NativeShellSafetyCheck', key: 'native_shell_safety_check', matcher: '^Bash$' },
      ]
    : [{ event: 'PreToolUse', key: 'pre_tool_use', matcher: MATCHER }];
  const groups = [
    ...effectGroups.map((group) => ({ ...group, command, index: 0 })),
    { event: 'PreToolUse', key: 'pre_tool_use', matcher: '.*', command: secretCommand, index: 1 },
    { event: 'PostToolUse', key: 'post_tool_use', matcher: '.*', command: secretCommand, index: 0 },
  ];
  const hookConfig = [
    'hooks={',
    ...[...new Set(groups.map(({ event }) => event))].map(
      (event) =>
        `${event}=[${groups
          .filter((group) => group.event === event)
          .map(
            ({ matcher, command }) =>
              `{matcher=${tomlString(matcher)},hooks=[{type="command",command=${tomlString(command)},timeout=${TIMEOUT_SECONDS},statusMessage=${tomlString(STATUS_MESSAGE)}}]}`,
          )
          .join(',')}],`,
    ),
    `state={${groups
      .map(
        ({ key, matcher, command, index }) =>
          `${tomlString(`/<session-flags>/config.toml:${key}:${index}:0`)}={enabled=true,trusted_hash=${tomlString(hookHash(command, key, matcher))}}`,
      )
      .join(',')}}`,
    '}',
  ].join('');
  return ['--config', 'features.hooks=true', '--config', hookConfig];
}

export function nativeEffectGuardHookHash(command: string): string {
  return hookHash(command);
}

function hookHash(command: string, eventName = 'pre_tool_use', matcher = MATCHER): string {
  const identity = {
    event_name: eventName,
    hooks: [
      {
        async: false,
        command,
        statusMessage: STATUS_MESSAGE,
        timeout: TIMEOUT_SECONDS,
        type: 'command',
      },
    ],
    matcher,
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
  return secretRuntimeRoot();
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
