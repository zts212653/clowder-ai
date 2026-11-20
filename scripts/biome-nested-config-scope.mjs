import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['biome.json', 'biome.jsonc', '.biome.json', '.biome.jsonc'];
export const biomeConfigPathPattern = /(^|\/)\.?biome\.jsonc?$/;

export function uniqueRootConfigPath(entries) {
  const roots = entries.filter(({ path }) => !path.includes('/') && biomeConfigPathPattern.test(path));
  return roots.length === 1 ? roots[0].path : undefined;
}

export function isLocalBiomeConfig(path, config, rootPath) {
  if (!rootPath || !config || Array.isArray(config) || typeof config !== 'object' || config.plugins) return false;
  const references = config.extends === undefined ? [] : config.extends;
  const list = typeof references === 'string' ? [references] : references;
  if (!Array.isArray(list)) return false;
  if (path === rootPath) return list.length === 0;
  if (config.root !== false) return false;

  const directPath = posix.relative(posix.dirname(path), rootPath);
  // A segment such as assets/.. can require a directory outside the snapshot.
  // Only remove "." segments, which resolve inside directories we already capture.
  return list.every(
    (ref) =>
      typeof ref === 'string' &&
      ref
        .split('/')
        .filter((segment) => segment !== '.')
        .join('/') === directPath,
  );
}

function indexedConfigsAreLocal() {
  const paths = names.flatMap((name) => [name, `:(glob)**/${name}`]);
  const entries = execFileSync('git', ['ls-files', '--stage', '-z', '--', ...paths], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, oid, stage] = entry.slice(0, tab).split(' ');
      return { mode, oid, stage, path: entry.slice(tab + 1) };
    })
    .filter(({ path }) => biomeConfigPathPattern.test(path));
  const rootPath = uniqueRootConfigPath(entries);
  if (!rootPath) return false;

  return entries.every((entry) => {
    if (entry.stage !== '0' || !['100644', '100755'].includes(entry.mode)) return false;
    const config = JSON.parse(execFileSync('git', ['cat-file', 'blob', entry.oid], { encoding: 'utf8' }));
    return isLocalBiomeConfig(entry.path, config, rootPath);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = indexedConfigsAreLocal() ? 0 : 1;
  } catch {
    // Shared, opaque, symlinked or unresolved inputs keep the existing global lane.
    process.exitCode = 1;
  }
}
