import { randomUUID } from 'node:crypto';
import { access, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createModuleLogger } from '../../logger.js';

const log = createModuleLogger('plugin-filesystem');

const mutations = new Map<string, Promise<unknown>>();

/** Installation publication and uninstall share one per-plugin mutation lane. */
export function withPluginMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  mutations.set(path, pending);
  void pending
    .finally(() => {
      if (mutations.get(path) === pending) mutations.delete(path);
    })
    .catch(() => {});
  return pending;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Keep the installed tree recoverable if publishing the validated staging tree fails. */
export async function replacePluginTree(extractedDir: string, targetDir: string): Promise<boolean> {
  const isUpdate = await pathExists(targetDir);
  const backup = join(dirname(targetDir), `.tmp-previous-${randomUUID()}`);
  if (isUpdate) await rename(targetDir, backup);
  try {
    await rename(extractedDir, targetDir);
  } catch (error) {
    if (isUpdate) await rename(backup, targetDir);
    throw error;
  }
  if (isUpdate)
    await rm(backup, { recursive: true, force: true }).catch((error) => {
      log.warn({ err: error, backup }, 'Installed plugin; previous tree cleanup failed');
    });
  return isUpdate;
}
