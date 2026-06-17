import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { validateSkillName } from '../config/governance/skill-sync.js';
import { listSourceSkillNames } from '../config/governance/skills-state.js';
import { pathsEqual } from './project-path.js';

const PROJECT_PROVIDER_SKILL_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

export class ManagedSkillWritebackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedSkillWritebackConflictError';
  }
}

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function isManagedDirectoryLevelSkillsSymlink(skillsDir: string, skillsSource: string): Promise<boolean> {
  const stat = await lstatIfExists(skillsDir);
  if (!stat?.isSymbolicLink()) return false;

  const [mountedRoot, expectedRoot] = await Promise.all([realpathOrSelf(skillsDir), realpath(skillsSource)]);
  return pathsEqual(mountedRoot, expectedRoot);
}

async function isProviderRootSymlink(skillsDir: string): Promise<boolean> {
  return (await lstatIfExists(skillsDir))?.isSymbolicLink() ?? false;
}

async function isManagedSkillSymlink(linkPath: string, skillsSource: string, skillName: string): Promise<boolean> {
  const stat = await lstatIfExists(linkPath);
  if (!stat?.isSymbolicLink()) return false;

  const target = await readlink(linkPath);
  const absoluteTarget = resolve(dirname(linkPath), target);
  const expectedTarget = resolve(skillsSource, skillName);
  if (pathsEqual(absoluteTarget, expectedTarget)) return true;
  const [realTarget, realExpected] = await Promise.all([
    realpathOrSelf(absoluteTarget),
    realpathOrSelf(expectedTarget),
  ]);
  return pathsEqual(realTarget, realExpected);
}

async function classifySkillPath(
  linkPath: string,
  skillsSource: string,
  skillName: string,
): Promise<'missing' | 'managed' | 'conflict'> {
  const stat = await lstatIfExists(linkPath);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink() && (await isManagedSkillSymlink(linkPath, skillsSource, skillName))) {
    return 'managed';
  }
  return 'conflict';
}

export async function mountManagedSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  opts?: { disabledSkillNames?: Iterable<string> },
): Promise<void> {
  validateSkillName(skillName);
  await lstat(join(skillsSource, skillName));

  const managedDirectoryRoots: string[] = [];
  const missingLinks: Array<{ skillsDir: string; linkPath: string }> = [];
  for (const providerDir of PROJECT_PROVIDER_SKILL_DIRS) {
    const skillsDir = join(projectRoot, providerDir);
    if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
      managedDirectoryRoots.push(skillsDir);
      continue;
    }
    if (await isProviderRootSymlink(skillsDir)) {
      throw new ManagedSkillWritebackConflictError(
        `Refusing to mount skill "${skillName}" at ${skillsDir}: provider skills root is not a managed Clowder AI symlink.`,
      );
    }

    const linkPath = join(skillsDir, skillName);
    const existing = await classifySkillPath(linkPath, skillsSource, skillName);
    if (existing === 'managed') continue;
    if (existing === 'conflict') {
      throw new ManagedSkillWritebackConflictError(
        `Refusing to mount skill "${skillName}" at ${linkPath}: path already exists and is not a managed Clowder AI skill symlink.`,
      );
    }

    missingLinks.push({ skillsDir, linkPath });
  }

  const disabledSkillNames = new Set(opts?.disabledSkillNames ?? []);
  const enabledSourceSkillNames =
    managedDirectoryRoots.length === 0
      ? []
      : (await listSourceSkillNames(skillsSource)).filter((name) => !disabledSkillNames.has(name));

  const convertedRoots: Array<{ skillsDir: string; target: string }> = [];
  const createdLinks: string[] = [];
  try {
    for (const skillsDir of managedDirectoryRoots) {
      const target = await readlink(skillsDir);
      convertedRoots.push({ skillsDir, target });
      await rm(skillsDir);
      await mkdir(skillsDir, { recursive: true });
      for (const sourceSkillName of enabledSourceSkillNames) {
        const linkPath = join(skillsDir, sourceSkillName);
        await symlink(symlinkTargetFor(linkPath, join(skillsSource, sourceSkillName)), linkPath);
      }
    }

    for (const { skillsDir, linkPath } of missingLinks) {
      await mkdir(skillsDir, { recursive: true });
      await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
      createdLinks.push(linkPath);
    }
  } catch (err) {
    for (const linkPath of createdLinks.reverse()) {
      await rm(linkPath).catch(() => {});
    }
    for (const { skillsDir, target } of convertedRoots.reverse()) {
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {});
      await symlink(target, skillsDir).catch(() => {});
    }
    throw err;
  }
}

export async function unmountManagedSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  opts?: { disabledSkillNames?: Iterable<string> },
): Promise<void> {
  validateSkillName(skillName);

  const managedDirectoryRoots: string[] = [];
  const skillLinksToRemove: string[] = [];
  for (const providerDir of PROJECT_PROVIDER_SKILL_DIRS) {
    const skillsDir = join(projectRoot, providerDir);
    if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
      managedDirectoryRoots.push(skillsDir);
      continue;
    }
    if (await isProviderRootSymlink(skillsDir)) continue;
    const linkPath = join(skillsDir, skillName);
    if (await isManagedSkillSymlink(linkPath, skillsSource, skillName)) {
      skillLinksToRemove.push(linkPath);
    }
  }

  const disabledSkillNames = new Set(opts?.disabledSkillNames ?? []);
  disabledSkillNames.add(skillName);
  const enabledSourceSkillNames = (await listSourceSkillNames(skillsSource)).filter(
    (name) => !disabledSkillNames.has(name),
  );

  const convertedRoots: Array<{ skillsDir: string; target: string }> = [];
  const removedLinks: Array<{ linkPath: string; target: string }> = [];
  try {
    for (const skillsDir of managedDirectoryRoots) {
      const target = await readlink(skillsDir);
      convertedRoots.push({ skillsDir, target });
      await rm(skillsDir);
      await mkdir(skillsDir, { recursive: true });
      for (const sourceSkillName of enabledSourceSkillNames) {
        const linkPath = join(skillsDir, sourceSkillName);
        await symlink(symlinkTargetFor(linkPath, join(skillsSource, sourceSkillName)), linkPath);
      }
    }

    for (const linkPath of skillLinksToRemove) {
      const target = await readlink(linkPath);
      removedLinks.push({ linkPath, target });
      await rm(linkPath);
    }
  } catch (err) {
    for (const { linkPath, target } of removedLinks.reverse()) {
      await rm(linkPath, { force: true }).catch(() => {});
      await symlink(target, linkPath).catch(() => {});
    }
    for (const { skillsDir, target } of convertedRoots.reverse()) {
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {});
      await symlink(target, skillsDir).catch(() => {});
    }
    throw err;
  }
}
