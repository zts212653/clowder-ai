import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { hasClaudeQuotaAuthOverride } from './claude-quota-identity.js';
import { CLAUDE_TOKEN_AUTH_KEYS } from './claude-token-account.js';
import { claudeSettingSources } from './claude-token-settings.js';

function safeDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.apiKeyHelper) return false;
  const env = doc.env;
  if (env === undefined) return true;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  return (
    !hasClaudeQuotaAuthOverride(env as Record<string, unknown>) &&
    !CLAUDE_TOKEN_AUTH_KEYS.some((key) => Object.hasOwn(env, key))
  );
}
function safeFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= 262144 && safeDocument(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Read attribution only: ambiguous settings suppress quota proof, never the invocation itself. */
export function nativeClaudeQuotaSourceKnown(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): boolean {
  if (hasClaudeQuotaAuthOverride(env)) return false;
  // A direct native OAuth token is fingerprinted; alternate inherited auth is not that login.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value && key !== 'CLAUDE_CODE_OAUTH_TOKEN'),
  );
  if (hasClaudeQuotaAuthOverride(inherited)) return false;
  for (let i = 0; i < args.length; i++) {
    const settings =
      args[i] === '--settings' ? args[++i] : args[i].startsWith('--settings=') ? args[i].slice(11) : undefined;
    if (settings === undefined) continue;
    try {
      if (
        settings.trimStart().startsWith('{') ? !safeDocument(JSON.parse(settings)) : !safeFile(resolve(cwd, settings))
      )
        return false;
    } catch {
      return false;
    }
  }
  const sources = claudeSettingSources(args);
  if (sources.some((source) => !['user', 'project', 'local'].includes(source))) return false;
  if (
    sources.includes('user') &&
    !safeFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'))
  )
    return false;
  if (sources.includes('project') && !safeFile(join(cwd, '.claude/settings.json'))) return false;
  if (!sources.includes('local')) return true;
  const roots = new Set([resolve(cwd)]);
  try {
    const output = execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [top, common] = output.trim().split('\n');
    if (top) roots.add(top);
    if (common && basename(common) === '.git') roots.add(dirname(common));
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (!/not a git repository/i.test(stderr)) return false;
  }
  return [...roots].every((root) => safeFile(join(root, '.claude/settings.local.json')));
}
