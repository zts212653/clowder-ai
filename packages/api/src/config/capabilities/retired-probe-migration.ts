import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { createModuleLogger } from '../../infrastructure/logger.js';

// F193 Phase D and its migration guide retire these three debugging entries.
// The fingerprint pins the observed probe implementation, not an arbitrary name.
const probeSource = '3bfb1cdc8bdcca70024d5c19eaeef63bbbee241f7b38ef7ff9e5454922d0600c';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Entry = Record<string, unknown>;
const record = (value: unknown): Entry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_probe_config');
  return value as Entry;
};
const hasOnlyFields = (value: Entry, fields: readonly string[]) =>
  Object.keys(value).every((key) => fields.includes(key));

function isCanonicalEnabledExternalCapability(entry: Entry): entry is Entry & { id: string } {
  return (
    hasOnlyFields(entry, ['id', 'type', 'source', 'enabled', 'mcpServer', 'globalEnabled', 'blockedCats']) &&
    typeof entry.id === 'string' &&
    entry.type === 'mcp' &&
    entry.source === 'external' &&
    entry.enabled === true &&
    (entry.globalEnabled === undefined || entry.globalEnabled === true) &&
    (entry.blockedCats === undefined || (Array.isArray(entry.blockedCats) && entry.blockedCats.length === 0))
  );
}

function isOriginalProbeEnvironment(name: string, launch: Entry): boolean {
  if (!('env' in launch)) return true;
  const env = launch.env;
  return (
    name === 'probe-env' &&
    !!env &&
    typeof env === 'object' &&
    !Array.isArray(env) &&
    Object.keys(env).length === 1 &&
    (env as Entry).OPENAI_API_KEY === 'test-key'
  );
}

function isOriginalProbeCwd(launch: Entry, cwdField: string, fingerprintedSource: string): boolean {
  if (!(cwdField in launch)) return true;
  // The already-fingerprinted fixture embeds its original API cwd. Never use
  // the current deployment root as evidence for a user-chosen launch directory.
  const literal = /process\.chdir\(("(?:[^"\\]|\\.)*")\);$/u.exec(fingerprintedSource)?.[1];
  return literal !== undefined && launch[cwdField] === JSON.parse(literal);
}

async function isOriginalNodeCommand(command: unknown): Promise<boolean> {
  if (typeof command !== 'string') return false;
  if (command === 'node') return true;
  try {
    return (await realpath(command)) === (await realpath(process.execPath));
  } catch {
    return false;
  }
}

async function retired(name: string, value: unknown, carrier: 'capabilities' | 'claude' | 'codex'): Promise<boolean> {
  if (
    !['probe-connected', 'probe-env', 'probe-off'].includes(name) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false;
  const launch = record(value);
  const cwdField = carrier === 'capabilities' ? 'workingDir' : 'cwd';
  // Codex accepts an explicit true exactly like its omitted enablement default.
  // It remains an unknown launch field for the other two carriers.
  const enabledFields = carrier === 'codex' ? ['enabled'] : [];
  // Matching old code is insufficient once a user has customized its launch.
  if (
    !hasOnlyFields(launch, ['command', 'args', cwdField, 'env', ...enabledFields]) ||
    ('enabled' in launch && launch.enabled !== true)
  )
    return false;
  const args = launch.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return false;
  if (name === 'probe-off')
    return (
      hasOnlyFields(launch, ['command', 'args', ...enabledFields]) &&
      launch.command === 'echo' &&
      args.length === 1 &&
      args[0] === 'ok'
    );
  if (!(await isOriginalNodeCommand(launch.command))) return false;
  if (args.length !== 3 || args[0] !== '--input-type=module' || args[1] !== '--eval' || sha(args[2]) !== probeSource)
    return false;
  return isOriginalProbeCwd(launch, cwdField, args[2]) && isOriginalProbeEnvironment(name, launch);
}

/** Run only under the persistent config owner's existing capability lock. */
export async function migrateOwnedRetiredProbes(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];
  for (const [relative, carrier] of [
    ['.cat-cafe/capabilities.json', 'capabilities'],
    ['.mcp.json', 'claude'],
    ['.codex/config.toml', 'codex'],
  ] as const) {
    const path = join(projectRoot, relative);
    try {
      const directory = await lstat(dirname(path));
      const stat = await lstat(path);
      if (directory.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile()) continue;
      const original = await readFile(path, 'utf8');
      const toml = relative.endsWith('.toml');
      const parsed = record(toml ? parse(original) : JSON.parse(original));
      const names: string[] = [];
      if (relative === '.cat-cafe/capabilities.json') {
        if (![1, 2].includes(Number(parsed.version)) || !Array.isArray(parsed.capabilities)) continue;
        const retained = [];
        for (const value of parsed.capabilities) {
          const entry = record(value);
          if (isCanonicalEnabledExternalCapability(entry) && (await retired(entry.id, entry.mcpServer, carrier)))
            names.push(entry.id);
          else retained.push(value);
        }
        parsed.capabilities = retained;
      } else {
        const key = toml ? 'mcp_servers' : 'mcpServers';
        const servers = record(parsed[key]);
        for (const [name, value] of Object.entries(servers)) {
          if (!(await retired(name, value, carrier))) continue;
          delete servers[name];
          names.push(name);
        }
      }
      if (!names.length) continue;
      const backup = `${path}.before-f333-probes-${sha(original).slice(0, 16)}`;
      try {
        await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(backup, 'utf8')) !== original)
          throw error;
      }
      const temporary = `${path}.f333-probes-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, toml ? stringify(parsed) : `${JSON.stringify(parsed, null, 2)}\n`, {
          flag: 'wx',
          mode: stat.mode & 0o777,
        });
        if ((await readFile(path, 'utf8')) !== original) throw new Error('probe_config_changed');
        await rename(temporary, path);
        removed.push(...names);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      createModuleLogger('retired-probe-migration').warn(
        { path },
        'Probe migration skipped; user configuration was preserved',
      );
    }
  }
  return [...new Set(removed)];
}
