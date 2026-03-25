/**
 * SkillInstallManager — SkillHub 安装/卸载核心服务
 *
 * 安装流程: 冲突检测 → 下载 → 验证 → 写入 → symlink → 更新 registry
 * 卸载流程: 权限检查 → 删除 symlink → 删除目录 → 更新 registry
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SkillHubInstallRequest, SkillHubInstallResult } from '@cat-cafe/shared';
import { parseSkillFrontmatter } from './frontmatter-parser.js';
import { addInstalledSkill, loadInstalledRegistry, removeInstalledSkill } from './InstalledSkillRegistry.js';
import { fetchSkillAllFiles } from './SkillHubService.js';
import { createProviderSymlinks, removeProviderSymlinks } from './SymlinkManager.js';

const MAX_SKILL_SIZE = 3_000_000; // 3MB
const PATH_TRAVERSAL_RE = /[/\\]|\.\./;

/** SkillHub 安装/卸载错误 */
export class SkillInstallError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONFLICT' | 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'DOWNLOAD',
  ) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

/**
 * 安装远程 skill 到本地。
 *
 * 1. 验证 localName 格式
 * 2. 冲突检测（本地同名拒绝，远程覆盖允许）
 * 3. 从 SkillHub 下载 SKILL.md
 * 4. 验证 frontmatter + 文件大小
 * 5. 写入 cat-cafe-skills/{localName}/SKILL.md
 * 6. 创建 provider symlinks
 * 7. 更新 .cat-cafe/installed-skills.json
 */
export async function installSkill(catCafeRoot: string, req: SkillHubInstallRequest): Promise<SkillHubInstallResult> {
  const localName = req.localName ?? req.skill;
  const skillsDir = resolve(catCafeRoot, 'cat-cafe-skills');
  const skillDir = join(skillsDir, localName);

  // 1. 验证 localName（只防路径穿越，不限制字符集）
  if (!localName || PATH_TRAVERSAL_RE.test(localName)) {
    throw new SkillInstallError(`Invalid skill name "${localName}": contains path traversal`, 'VALIDATION');
  }

  // 2. 冲突检测
  const registry = await loadInstalledRegistry(catCafeRoot);
  const isRemoteInstalled = registry.skills.some((s) => s.name === localName);
  if (existsSync(skillDir) && !isRemoteInstalled) {
    throw new SkillInstallError(
      `Local skill "${localName}" already exists. Cannot overwrite a local skill.`,
      'CONFLICT',
    );
  }

  // 3. 下载并解压全部文件
  let files: Map<string, Buffer>;
  try {
    files = await fetchSkillAllFiles(req.owner, req.repo, req.skill);
  } catch (err) {
    throw new SkillInstallError(
      `Failed to download skill: ${err instanceof Error ? err.message : String(err)}`,
      'DOWNLOAD',
    );
  }

  // 4. 验证
  const skillMd = files.get('SKILL.md');
  if (!skillMd) {
    throw new SkillInstallError('ZIP does not contain SKILL.md', 'VALIDATION');
  }
  if (skillMd.length > MAX_SKILL_SIZE) {
    throw new SkillInstallError(`SKILL.md exceeds ${MAX_SKILL_SIZE} bytes`, 'VALIDATION');
  }
  if (skillMd.toString('utf-8').trim().length === 0) {
    throw new SkillInstallError('SKILL.md content is empty', 'VALIDATION');
  }

  // 5. 写入全部文件
  await mkdir(skillDir, { recursive: true });
  for (const [filePath, fileContent] of files) {
    // 防止路径穿越
    if (filePath.includes('..') || filePath.startsWith('/')) continue;
    const fullPath = join(skillDir, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, fileContent);
  }

  // 6. 创建 symlinks
  const mounts = await createProviderSymlinks(localName, skillsDir);

  // 7. 更新 registry
  await addInstalledSkill(catCafeRoot, {
    name: localName,
    source: 'skillhub',
    skillhubUrl: `https://skillhub.tencent.com/skills/${encodeURIComponent(req.skill)}`,
    owner: req.owner,
    repo: req.repo,
    remoteSkillName: req.skill,
    installedAt: new Date().toISOString(),
  });

  return {
    success: true,
    name: localName,
    localPath: `cat-cafe-skills/${localName}`,
    mounts,
  };
}

/**
 * 卸载远程安装的 skill。
 *
 * 1. 检查 skill 在 installed-skills.json 中
 * 2. 检查 skill 不在 BOOTSTRAP.md 中（防止误删本地 skill）
 * 3. 删除 provider symlinks
 * 4. 删除 cat-cafe-skills/{name}/ 目录
 * 5. 更新 registry
 */
export async function uninstallSkill(catCafeRoot: string, name: string, bootstrapNames: Set<string>): Promise<void> {
  // 1. 检查 registry
  const registry = await loadInstalledRegistry(catCafeRoot);
  const isRemoteInstalled = registry.skills.some((s) => s.name === name);
  if (!isRemoteInstalled) {
    throw new SkillInstallError(`Skill "${name}" is not installed via SkillHub`, 'NOT_FOUND');
  }

  // 2. 双重校验：不能卸载本地 skill
  if (bootstrapNames.has(name)) {
    throw new SkillInstallError(`Skill "${name}" is a local skill. Cannot uninstall local skills.`, 'FORBIDDEN');
  }

  const skillsDir = resolve(catCafeRoot, 'cat-cafe-skills');

  // 3. 删除 symlinks
  await removeProviderSymlinks(name);

  // 4. 删除目录
  const skillDir = join(skillsDir, name);
  try {
    await rm(skillDir, { recursive: true, force: true });
  } catch {
    // 目录可能不存在，忽略
  }

  // 5. 更新 registry
  await removeInstalledSkill(catCafeRoot, name);
}

/** 获取已安装的远程 skill 名称集合 */
export async function getInstalledRemoteNames(catCafeRoot: string): Promise<Set<string>> {
  const registry = await loadInstalledRegistry(catCafeRoot);
  return new Set(registry.skills.map((s) => s.name));
}

/** 获取已安装的远程 skill 详细信息 */
export async function getInstalledRecords(catCafeRoot: string) {
  const registry = await loadInstalledRegistry(catCafeRoot);
  return registry.skills;
}
