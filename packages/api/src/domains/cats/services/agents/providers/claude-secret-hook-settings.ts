import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';

const SCRIPT = secretRuntimeScript('secret-native-hook.mjs');
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Add host-owned hooks after composition, so project cwd and custom settings cannot drop them. */
export function withClaudeSecretHooks(settings?: string, cwd = process.cwd()): string {
  if (!existsSync(SCRIPT)) throw new Error('secret_native_hook_unavailable');
  let document: Record<string, unknown> = {};
  if (settings !== undefined) {
    try {
      const text = settings.trim().startsWith('{') ? settings : readFileSync(resolve(cwd, settings), 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      document = record(parsed);
    } catch {
      throw new Error('cli_config_args_settings_invalid');
    }
  }
  const hooks = record(document.hooks);
  const command = `${quote(process.execPath)} ${quote(SCRIPT)}`;
  const managed = { matcher: '.*', hooks: [{ type: 'command', command, timeout: 8 }] };
  return JSON.stringify({
    ...document,
    disableAllHooks: false,
    hooks: {
      ...hooks,
      PreToolUse: [...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []), managed],
      PostToolUse: [...(Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []), managed],
    },
  });
}
