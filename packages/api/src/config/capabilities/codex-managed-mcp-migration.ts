import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { CAT_CAFE_SPLIT_ENTRYPOINTS } from './mcp-constants.js';

type Entry = Record<string, unknown>;
const record = (value: unknown): Entry =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Entry) : {};

async function ownedEntry(
  name: string,
  value: unknown,
  roots: readonly string[],
  projectRoot: string,
): Promise<boolean> {
  const file = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
  const entry = record(value);
  if (
    !file ||
    typeof entry.command !== 'string' ||
    !Array.isArray(entry.args) ||
    entry.args.length !== 1 ||
    typeof entry.args[0] !== 'string'
  )
    return false;
  try {
    if (entry.command !== 'node' && (await realpath(entry.command)) !== (await realpath(process.execPath)))
      return false;
    const target = await realpath(resolve(typeof entry.cwd === 'string' ? entry.cwd : projectRoot, entry.args[0]));
    for (const root of roots) {
      try {
        if (target === (await realpath(join(root, 'packages/mcp-server/dist', file)))) return true;
      } catch {
        /* another known install root may own it */
      }
    }
  } catch {
    /* unknown ownership is preserved */
  }
  return false;
}

async function preserve(path: string, bytes: string): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(path, 'utf8')) !== bytes) throw error;
  }
}

/** Called under the existing capability lock, only after the startup config-owner fence. */
export async function migrateOwnedCodexProjectMcp(
  projectRoot: string,
  installRoots: readonly string[],
): Promise<string[]> {
  const directory = join(projectRoot, '.codex');
  const path = join(directory, 'config.toml');
  let stat: Stats;
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('codex_project_config_not_owned');
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('codex_project_config_not_owned');
  const original = await readFile(path, 'utf8');
  const parsed = parse(original) as Record<string, unknown>;
  const servers = record(parsed.mcp_servers);
  const retained: Entry = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (await ownedEntry(name, entry, installRoots, projectRoot)) retained[name] = entry;
  }
  const names = Object.keys(retained);
  if (!names.length) return [];
  const sha = createHash('sha256').update(original).digest('hex').slice(0, 16);
  await preserve(join(directory, `config.before-f333-${sha}.toml`), original);
  await preserve(join(directory, `cat-cafe-stdio-${sha}.config.toml`), stringify({ mcp_servers: retained }));
  for (const name of names) delete servers[name];
  parsed.mcp_servers = servers;
  const temporary = join(dirname(path), `.config.f333-${randomUUID()}.tmp`);
  await writeFile(temporary, stringify(parsed), { flag: 'wx', mode: stat.mode & 0o777 });
  try {
    if ((await readFile(path, 'utf8')) !== original) throw new Error('codex_project_config_changed_during_migration');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return names;
}
