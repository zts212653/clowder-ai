/** Nonsecret per-launch overlay; original user/project settings are never edited or copied. */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_TOKEN_AUTH_KEYS } from './claude-token-account.js';

const execGit = promisify(execFile);
async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings');
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('claude_token_settings_unreadable');
  }
}
function assertNoTokenOverride(doc: Record<string, unknown>): void {
  const env = doc.env;
  if (env && typeof env === 'object' && Object.hasOwn(env, 'CLAUDE_CODE_OAUTH_TOKEN'))
    throw new Error('claude_token_settings_conflict');
}
export function claudeSettingSources(args: readonly string[]): string[] {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--setting-sources') value = args[++i];
    else if (args[i].startsWith('--setting-sources=')) value = args[i].slice('--setting-sources='.length);
  }
  return value === undefined ? ['user', 'project', 'local'] : value.split(',').filter(Boolean);
}
export async function composeClaudeTokenSettingsDocument(
  settings?: string,
  cwd = process.cwd(),
  sources = ['user', 'project', 'local'],
): Promise<string> {
  let doc: Record<string, unknown> = {};
  if (settings) {
    try {
      doc = settings.trimStart().startsWith('{') ? JSON.parse(settings) : await readSettings(resolve(cwd, settings));
    } catch {
      throw new Error('claude_token_settings_unreadable');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('claude_token_settings_unreadable');
    assertNoTokenOverride(doc);
  }
  if (sources.includes('user'))
    assertNoTokenOverride(
      await readSettings(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')),
    );
  const projectRoot = resolve(cwd);
  if (sources.includes('project'))
    assertNoTokenOverride(await readSettings(join(projectRoot, '.claude/settings.json')));
  if (sources.includes('local')) {
    const roots = new Set([projectRoot]);
    try {
      const { stdout } = await execGit(
        'git',
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
        { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const [gitRoot, commonDir] = stdout.trim().split('\n');
      if (gitRoot) roots.add(gitRoot);
      // Since CLI 2.1.211, linked worktrees consume the main checkout's local file.
      if (commonDir && basename(commonDir) === '.git') roots.add(dirname(commonDir));
    } catch (error) {
      // Only a confirmed non-Git workspace can safely use the launch directory alone.
      if (!/not a git repository/i.test((error as { stderr?: string }).stderr ?? ''))
        throw new Error('claude_token_settings_unreadable');
    }
    for (const path of roots) assertNoTokenOverride(await readSettings(join(path, '.claude/settings.local.json')));
  }
  return JSON.stringify({
    ...doc,
    apiKeyHelper: '',
    env: {
      ...(doc.env && typeof doc.env === 'object' ? doc.env : {}),
      ...Object.fromEntries(CLAUDE_TOKEN_AUTH_KEYS.map((key) => [key, ''])),
    },
  });
}
