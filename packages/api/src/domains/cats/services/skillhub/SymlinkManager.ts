/**
 * SymlinkManager — Provider Symlink 管理器
 *
 * 为每个 skill 创建/删除 per-skill symlink 到 ~/.claude/skills, ~/.codex/skills, ~/.gemini/skills。
 * 使用相对路径 symlink，与 governance-bootstrap.ts 一致。
 */

import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export interface ProviderMounts {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

interface ProviderConfig {
  key: keyof ProviderMounts;
  dir: string;
}

function getProviders(): ProviderConfig[] {
  const home = homedir();
  return [
    { key: 'claude', dir: join(home, '.claude', 'skills') },
    { key: 'codex', dir: join(home, '.codex', 'skills') },
    { key: 'gemini', dir: join(home, '.gemini', 'skills') },
  ];
}

/**
 * 检查 symlink 是否指向预期目标
 */
async function isCorrectSymlink(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = dest.startsWith('/') ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    return realDest.replace(/\/$/, '') === realExpected.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * 为指定 skill 创建三个 provider 的 per-skill symlink。
 * 已存在且正确 → 跳过；已存在但不正确 → 跳过（不覆盖）；不存在 → 创建。
 */
export async function createProviderSymlinks(skillName: string, skillsDir: string): Promise<ProviderMounts> {
  const target = resolve(skillsDir, skillName);
  const providers = getProviders();
  const mounts: ProviderMounts = { claude: false, codex: false, gemini: false };

  for (const p of providers) {
    const linkPath = join(p.dir, skillName);

    try {
      // 检查是否已是正确 symlink
      if (await isCorrectSymlink(linkPath, target)) {
        mounts[p.key] = true;
        continue;
      }

      // 存在但不是正确 symlink → 跳过，不覆盖
      const stat = await lstat(linkPath);
      if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
        mounts[p.key] = false;
        continue;
      }
    } catch {
      // 不存在，继续创建
    }

    try {
      await mkdir(p.dir, { recursive: true });
      const relPath = relative(p.dir, target);
      // Windows: use 'junction' type (no admin required for directory symlinks)
      const linkType = process.platform === 'win32' ? 'junction' : 'file';
      await symlink(relPath, linkPath, linkType);
      mounts[p.key] = true;
    } catch {
      mounts[p.key] = false;
    }
  }

  return mounts;
}

/**
 * 删除指定 skill 的三个 provider symlink。
 * 只删除 symlink 类型的文件，不删除其他类型的同名文件。
 */
export async function removeProviderSymlinks(skillName: string): Promise<void> {
  const providers = getProviders();

  for (const p of providers) {
    const linkPath = join(p.dir, skillName);
    try {
      const stat = await lstat(linkPath);
      if (stat.isSymbolicLink()) {
        await rm(linkPath);
      }
    } catch {
      // 不存在或无法访问，跳过
    }
  }
}
