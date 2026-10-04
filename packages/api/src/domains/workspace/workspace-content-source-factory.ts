import { resolveCurrentWorkspaceContentRoot } from './roots/workspace-content-root-resolution.js';
import { WorkspaceContentSourceService } from './workspace-content-source.js';
import { getLinkedRootsAsync, listWorktrees, WorkspaceSecurityError } from './workspace-security.js';

export async function resolveWorkspaceContentRoot(worktreeId: string) {
  const resolved = await resolveCurrentWorkspaceContentRoot(worktreeId, listWorktrees, getLinkedRootsAsync);
  if (!resolved) throw new WorkspaceSecurityError('Workspace root is not durably registered', 'NOT_FOUND');
  return resolved;
}

export function createWorkspaceContentSource(ownerUserId: string): WorkspaceContentSourceService {
  return new WorkspaceContentSourceService({ ownerUserId, resolveWorktreeRoot: resolveWorkspaceContentRoot });
}
