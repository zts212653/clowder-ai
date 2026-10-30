import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Settings = Record<string, unknown>;
function record(value: unknown): Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : {};
}
function settings(path: string): Settings {
  try {
    return record(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    // Claude print mode skips a malformed ordinary settings file as well.
    return {};
  }
}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/** Local configuration evidence only, for the same user/project/local sources as
 * the native carrier. Never starts Claude, executes a key helper, validates a key
 * over the network, returns credentials, or changes native settings/history.
 */
export function nativeClaudeConfiguration(projectRoot = process.cwd(), home = homedir()) {
  const files = [
    join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'),
    join(projectRoot, '.claude/settings.json'),
    join(projectRoot, '.claude/settings.local.json'),
  ];
  let document: Settings = {};
  let env: Settings = {};
  for (const file of files) {
    const next = settings(file);
    document = { ...document, ...next };
    env = { ...env, ...record(next.env) };
  }
  // Normal CLI launches apply settings env over inherited shell values. Retain
  // explicit empty overrides: they must not revive a shadowed lower-level key.
  const value = (key: string): unknown => (Object.hasOwn(env, key) ? env[key] : process.env[key]);
  return {
    hasCredential: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some((key) =>
      Boolean(text(value(key))),
    ),
    model: text(value('ANTHROPIC_MODEL')) ?? text(document.model),
    effort: text(value('CLAUDE_CODE_EFFORT_LEVEL')) ?? text(document.effortLevel),
  };
}

export function hasNativeClaudeApiConfig(projectRoot = process.cwd()): boolean {
  return nativeClaudeConfiguration(projectRoot).hasCredential;
}
