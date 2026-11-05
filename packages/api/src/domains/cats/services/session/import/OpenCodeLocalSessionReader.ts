import { runModuleWorker } from '../../../../../utils/run-module-worker.js';
import type { LocalSessionList } from '../../types.js';

export type OpenCodeLocalSelection = ({ sessionId: string } | { limit: number }) & { path?: string };
export type OpenCodeLocalReadResult =
  | { ok: true; listing: LocalSessionList }
  | { ok: false; code: 'SESSION_ACTIVE_WRITER' | 'SESSION_NOT_TOP_LEVEL' | 'SESSION_RESUME_FAILED' };

/** SQLite has no updated-time index on supported OpenCode versions. Keep its scan off the API loop. */
export async function readOpenCodeImport(input: OpenCodeLocalSelection): Promise<LocalSessionList> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const result = await runModuleWorker<OpenCodeLocalReadResult>({
    moduleUrl: new URL(`./OpenCodeLocalSessionWorker.${extension}`, import.meta.url),
    exportName: 'readOpenCodeLocalSessionOperation',
    input,
    isolation: 'process',
    timeoutMs: 8000,
  });
  if (!result.ok) throw Object.assign(new Error('OpenCode native session inspection failed'), { code: result.code });
  return result.listing;
}
