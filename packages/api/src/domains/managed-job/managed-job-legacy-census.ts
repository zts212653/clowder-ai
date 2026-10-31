import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCatCafeDataRoot } from '../../utils/cli-process-ownership.js';

/** Old live workers still write their original files. Discover them there, independent of wake-task state. */
export function legacyManagedJobOrigins(dataRoot = resolveCatCafeDataRoot()): { jobId: string; taskId: string }[] {
  const directory = join(dataRoot, 'managed-gate-jobs');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.gate.json')) return [];
    try {
      const record = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) as Record<string, unknown>;
      return typeof record.jobId === 'string' &&
        typeof record.originTaskId === 'string' &&
        entry.name === `${record.jobId}.json`
        ? [{ jobId: record.jobId, taskId: record.originTaskId }]
        : [];
    } catch {
      return [];
    }
  });
}
