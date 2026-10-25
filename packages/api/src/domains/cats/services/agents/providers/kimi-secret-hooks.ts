import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { parse, stringify } from 'smol-toml';
import { resolveKimiRuntimePaths } from '../../../../../utils/kimi-cli-runtime.js';

const START = '# BEGIN CAT CAFE SECRET HOOKS';
const END = '# END CAT CAFE SECRET HOOKS';
const SCRIPT = secretRuntimeScript('secret-kimi-hook.mjs');
const quote = (value: string) =>
  process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;

const managedCommand = () =>
  `${quote(process.execPath)} ${quote(SCRIPT)} || exit ${process.platform === 'win32' ? '/b ' : ''}2`;
function managedHooks() {
  const command = managedCommand();
  return `${START}\n${['PreToolUse', 'PostToolUse'].map((event) => `[[hooks]]\nevent = "${event}"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`).join('')}${END}\n`;
}

function isManagedHook(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hook = value as Record<string, unknown>;
  return (
    (hook.event === 'PreToolUse' || hook.event === 'PostToolUse') &&
    hook.command === managedCommand() &&
    hook.timeout === 30 &&
    hook.matcher === undefined
  );
}

function originalHookTables(text: string): string {
  let prefix = text;
  if (prefix.includes(START) || prefix.includes(END)) {
    const start = prefix.indexOf(START);
    const end = prefix.indexOf(END);
    if (start < 0 || end < start || prefix.indexOf(START, start + START.length) >= 0)
      throw new Error('secret_hook_config_managed_block_invalid');
    prefix = prefix.slice(0, start) + prefix.slice(end + END.length).replace(/^\r?\n/, '');
  }
  try {
    const { hooks, ...rest } = parse(prefix);
    if (hooks !== undefined && !Array.isArray(hooks)) throw new Error();
    // TOML cannot append [[hooks]] to a root inline array. Canonicalize only
    // this representation, preserving every decoded provider/user-hook value.
    if (Array.isArray(hooks)) {
      const retained = hooks.filter((hook) => !isManagedHook(hook));
      if (retained.length !== hooks.length || !/^\s*\[\[\s*(?:hooks|"hooks"|'hooks')\s*\]\]/m.test(prefix))
        return `${stringify(rest)}\n${retained.length ? stringify({ hooks: retained }) : ''}`;
    }
    return prefix;
  } catch {
    throw new Error('secret_hook_config_invalid');
  }
}

async function snapshot(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024)
      throw new Error('secret_hook_config_unsafe');
    const text = await readFile(path, 'utf8');
    return { text, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', identity: 'absent' };
    throw error;
  }
}

async function acquireHookLock(path: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      return await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('secret_hook_config_unavailable');
    }
    await delay(10);
  }
  throw new Error('secret_hook_config_busy');
}

/** Preserve the original native home and token fields; never expose config bytes in diagnostics. */
export async function ensureKimiSecretHooks(env: Record<string, string | undefined>): Promise<void> {
  const { configPath } = resolveKimiRuntimePaths(env);
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.cat-cafe-secret-hooks.lock');
  const lock = await acquireHookLock(lockPath);
  const temporary = join(directory, `.cat-cafe-secret-hooks-${randomUUID()}.tmp`);
  try {
    const original = await snapshot(configPath);
    const prefix = originalHookTables(original.text);
    const next = `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${managedHooks()}`;
    try {
      parse(next);
    } catch {
      throw new Error('secret_hook_config_invalid');
    }
    if (next === original.text) return;
    await writeFile(temporary, next, { flag: 'wx', mode: 0o600 });
    const current = await snapshot(configPath);
    if (current.identity !== original.identity || current.text !== original.text)
      throw new Error('secret_hook_config_changed');
    await rename(temporary, configPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('secret_hook_config_')) throw error;
    throw new Error('secret_hook_config_unavailable');
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
