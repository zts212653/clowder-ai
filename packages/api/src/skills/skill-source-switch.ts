import { lstat, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MountRules } from '@cat-cafe/shared';
import { createSkillSymlink } from '../utils/skill-mount.js';
import { allMountDirs } from './skill-mount-ops.js';
import { classifyMountPath } from './skill-sync-engine.js';

/** Journal only this skill's missing/managed links, never user files or foreign links. */
export async function withSkillMountRollback<T>(
  projectRoot: string,
  skillName: string,
  oldSource: string,
  newSource: string,
  rules: MountRules,
  operation: () => Promise<T>,
): Promise<T> {
  const before: Array<{ path: string; link?: string; directory?: { dev: number; ino: number } }> = [];
  for (const dir of allMountDirs(projectRoot, rules)) {
    try {
      const directory = await lstat(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      const path = join(dir, skillName);
      const status = await classifyMountPath(path, oldSource, skillName);
      if (status === 'conflict') continue;
      before.push({ path, directory, ...(status === 'managed' ? { link: await readlink(path) } : {}) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') before.push({ path: join(dir, skillName) });
      else if (!['ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? '')) throw error;
    }
  }
  try {
    return await operation();
  } catch (error) {
    const failures: unknown[] = [];
    for (const entry of before) {
      try {
        const status = await classifyMountPath(entry.path, newSource, skillName);
        // An unchanged old link or any concurrent foreign content is never removed.
        if (status === 'conflict') {
          if (entry.link !== undefined && (await readlink(entry.path).catch(() => undefined)) === entry.link) continue;
          if (entry.link !== undefined) throw new Error(`Skill mount changed during rollback: ${entry.path}`);
          continue;
        }
        if (entry.directory) {
          const directory = await lstat(join(entry.path, '..'));
          if (directory.dev !== entry.directory.dev || directory.ino !== entry.directory.ino) {
            throw new Error(`Skill mount directory changed during rollback: ${entry.path}`);
          }
        }
        if (status === 'managed') await rm(entry.path);
        if (entry.link !== undefined) await createSkillSymlink(entry.link, entry.path);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Skill source switch and rollback failed');
    throw error;
  }
}
