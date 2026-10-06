// Inspired by whutzefengxie-ops #1452. Always check bytes, never trust an
// architecture label in a path. Unreadable binaries/subtrees are build errors.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tokens = /(?:^|[-_/])(darwin|mas|linux|win32|freebsd|ios|android)[-_](arm64|x64|ia32|universal)(?=[-_/.]|$)/;
const magic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

function family(relative) {
  const match = tokens.exec(relative);
  if (!match) return { key: relative };
  return {
    platform: match[1],
    arch: match[2],
    key:
      relative.slice(0, match.index) +
      match[0].replace(match[2], '<arch>') +
      relative.slice(match.index + match[0].length),
  };
}

export function evaluateArch(entries, target) {
  const macho = { arm64: 'arm64', x64: 'x86_64' }[target];
  if (!macho) throw new Error(`Unsupported macOS target: ${target}`);
  const families = new Map();
  for (const entry of entries) {
    const parsed = family(entry.path);
    if (parsed.platform && !['darwin', 'mas'].includes(parsed.platform)) continue;
    const members = families.get(parsed.key) || [];
    members.push({ ...entry, ...parsed });
    families.set(parsed.key, members);
  }
  const failures = [];
  for (const members of families.values()) {
    // Multi-arch prebuild siblings are allowed only if the loader's actual
    // target member (or a universal binary) has verified target Mach-O bytes.
    const compatible = members.some(
      (entry) => (!entry.arch || entry.arch === target || entry.arch === 'universal') && entry.archs.includes(macho),
    );
    if (!compatible)
      failures.push(...members.map((entry) => `${entry.path}: [${entry.archs.join(', ')}] needs ${macho}`));
    for (const entry of members) {
      if (entry.archs.length === 0) failures.push(`${entry.path}: unreadable Mach-O architecture`);
      if (entry.arch === target && !entry.archs.includes(macho))
        failures.push(`${entry.path}: target label disagrees with binary`);
    }
  }
  return failures;
}

export function inspectBundle(app, target) {
  const root = fs.realpathSync(app);
  const visited = new Set();
  const entries = [];
  function walk(file) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const resolved = fs.realpathSync(file);
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      throw new Error(`Bundle symlink escapes app: ${relative}`);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (visited.has(resolved)) return;
      visited.add(resolved);
      for (const name of fs.readdirSync(file)) walk(path.join(file, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported bundle entry: ${relative}`);
    const parsed = family(relative);
    if (parsed.platform && !['darwin', 'mas'].includes(parsed.platform)) return;
    const header = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, header, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!magic.has(header.toString('hex')) && !/\.(node|dylib|so)$/.test(file)) return;
    const archs = execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8', timeout: 15000 })
      .trim()
      .split(/\s+/);
    entries.push({ path: relative, archs });
  }
  walk(root);
  if (!entries.some((entry) => entry.path.endsWith('/better_sqlite3.node')))
    throw new Error('Packaged better-sqlite3 binary missing');
  const failures = evaluateArch(entries, target);
  if (failures.length) throw new Error(`macOS bundle architecture failed:\n${failures.join('\n')}`);
  return entries.length;
}
