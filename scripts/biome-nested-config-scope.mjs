import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const names = new Set(['biome.json', 'biome.jsonc', '.biome.json', '.biome.jsonc']);

function referencesRootConfig(reference, configPath, roots) {
  return (
    !posix.isAbsolute(reference) &&
    !reference.includes('\\') &&
    roots.has(posix.normalize(posix.join(posix.dirname(configPath), reference)))
  );
}

function indexedConfigsAreLocal() {
  const paths = [...names].flatMap((name) => [name, `:(glob)**/${name}`]);
  const entries = execFileSync('git', ['ls-files', '--stage', '-z', '--', ...paths], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, oid, stage] = entry.slice(0, tab).split(' ');
      return { mode, oid, stage, path: entry.slice(tab + 1) };
    })
    .filter((entry) => names.has(posix.basename(entry.path)));
  const roots = new Set(entries.filter((entry) => !entry.path.includes('/')).map((entry) => entry.path));
  if (roots.size !== 1) return false;

  return entries.every((entry) => {
    if (entry.stage !== '0' || !['100644', '100755'].includes(entry.mode)) return false;
    const config = JSON.parse(execFileSync('git', ['cat-file', 'blob', entry.oid], { encoding: 'utf8' }));
    if (!config || Array.isArray(config) || typeof config !== 'object' || config.plugins) return false;
    const references = config.extends === undefined ? [] : config.extends;
    const list = typeof references === 'string' ? [references] : references;
    if (!Array.isArray(list) || list.some((ref) => typeof ref !== 'string')) return false;
    if (roots.has(entry.path)) return list.length === 0;
    if (config.root !== false) return false;
    return list.every((ref) => referencesRootConfig(ref, entry.path, roots));
  });
}

try {
  process.exitCode = indexedConfigsAreLocal() ? 0 : 1;
} catch {
  // Shared, opaque, symlinked or unresolved inputs keep the existing global lane.
  process.exitCode = 1;
}
