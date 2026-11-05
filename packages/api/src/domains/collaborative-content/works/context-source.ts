import type { WorkWorkspaceSource } from '@cat-cafe/shared';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { WorkspaceContentSourceError } from '../../workspace/workspace-content-source.js';
import type { WorkPrincipal } from './service.js';

export const MAX_VIDEO_WORK_INDEX_BYTES = 2 * 1024 * 1024;
export type WorkContextSource = (
  source: WorkWorkspaceSource,
  principal: WorkPrincipal,
) => Promise<{
  context: unknown;
  revalidate(): Promise<void>;
}>;

/** F063 still owns root authorization, no-follow descriptor, stable read and digest. */
export function createWorkContextSource(source: WorkspaceContentSourceService): WorkContextSource {
  return async (input, principal) => {
    const request = {
      principal: { userId: principal.userId },
      locator: { worktreeId: input.worktreeId, path: input.path },
    };
    const check = async () => {
      const description = await source.describe(request);
      if (description.kind !== 'text' || description.mime !== 'application/json')
        throw new WorkspaceContentSourceError('unsupported_text');
      if (description.byteLength > MAX_VIDEO_WORK_INDEX_BYTES) throw new WorkspaceContentSourceError('too_large');
      if (description.revision !== input.expectedSourceRevision)
        throw new WorkspaceContentSourceError('revision_changed');
    };
    await check();
    const snapshot = await source.readText({ ...request, expectedRevision: input.expectedSourceRevision });
    if (Buffer.byteLength(snapshot.text) > MAX_VIDEO_WORK_INDEX_BYTES)
      throw new WorkspaceContentSourceError('too_large');
    let context: unknown;
    try {
      context = JSON.parse(snapshot.text);
    } catch {
      throw new WorkspaceContentSourceError('unsupported_text');
    }
    return { context, revalidate: check };
  };
}
