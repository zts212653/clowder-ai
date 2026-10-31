import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function keys(path: string): string[] {
  try {
    return [resolve(path), realpathSync(path)];
  } catch {
    return [resolve(path)];
  }
}
/** Known local trust only; native runtime observation still owns managed/cloud corrections. */
export function codexProjectConfigDirectories(cwd: string, config: Record<string, unknown>): string[] {
  const configured = config.project_root_markers;
  const markers =
    Array.isArray(configured) && configured.every((value) => typeof value === 'string')
      ? (configured as string[])
      : ['.git'];
  let root = resolve(cwd);
  for (let dir = root; markers.length; dir = dirname(dir)) {
    if (markers.some((marker) => existsSync(join(dir, marker)))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  let repoRoot = root;
  const gitPath = join(root, '.git');
  try {
    const content = readFileSync(gitPath, 'utf8');
    if (content.startsWith('gitdir: ')) {
      const gitDir = resolve(root, content.slice(8).trim());
      const commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
      if (basename(commonDir) === '.git') repoRoot = dirname(commonDir);
    }
  } catch {
    /* ordinary checkout or no linked-worktree metadata */
  }
  const projects =
    config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : {};
  const trust = (dir: string): unknown => {
    for (const path of [...keys(dir), ...keys(root), ...keys(repoRoot)]) {
      const value = projects[path];
      if (value && typeof value === 'object' && 'trust_level' in value) return value.trust_level;
    }
    return undefined;
  };
  const dirs = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (trust(dir) === 'trusted') dirs.push(join(dir, '.codex'));
    if (dir === root || dirname(dir) === dir) break;
  }
  return dirs.reverse();
}
