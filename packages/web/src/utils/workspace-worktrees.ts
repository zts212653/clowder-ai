import { apiFetch } from '@/utils/api-client';
import { buildWorktreeAliasMap, resolveListedWorktreeId } from '@/utils/worktree-id-alias';

interface WorkspaceWorktree {
  id: string;
  canonicalId?: string | null;
  root: string;
}

export function workspaceWorktreesUrl(projectPath: string | null | undefined): {
  url: string;
  isScoped: boolean;
} {
  if (!projectPath || projectPath === 'default') {
    return { url: '/api/workspace/worktrees', isScoped: false };
  }
  const params = new URLSearchParams({ repoRoot: projectPath });
  return { url: `/api/workspace/worktrees?${params}`, isScoped: true };
}

export async function fetchWorkspaceWorktrees<T extends WorkspaceWorktree>(url: string): Promise<T[] | null> {
  try {
    const response = await apiFetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as { worktrees?: T[] };
    return data.worktrees ?? [];
  } catch {
    return null;
  }
}

export async function fetchWorktreesPreservingSelection<T extends WorkspaceWorktree>(
  scopedUrl: string,
  currentWorktreeId: string | null,
  projectPath: string,
): Promise<T[] | null> {
  const scopedList = await fetchWorkspaceWorktrees<T>(scopedUrl);
  if (!scopedList || !currentWorktreeId) return scopedList;

  const scopedAliases = buildWorktreeAliasMap(scopedList);
  if (resolveListedWorktreeId(scopedList, currentWorktreeId, scopedAliases)) return scopedList;

  const defaultList = await fetchWorkspaceWorktrees<T>('/api/workspace/worktrees');
  if (!defaultList) return scopedList;
  const defaultAliases = buildWorktreeAliasMap(defaultList);
  const listedId = resolveListedWorktreeId(defaultList, currentWorktreeId, defaultAliases);
  const selected = defaultList.find((worktree) => worktree.id === listedId);
  return selected && isPathWithinProject(selected.root, projectPath) ? defaultList : scopedList;
}

export function isPathWithinProject(path: string, projectPath: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/\/$/, '');
  const normalizedProject = projectPath.replaceAll('\\', '/').replace(/\/$/, '');
  const windowsPath = /^[a-zA-Z]:\//.test(normalizedPath) && /^[a-zA-Z]:\//.test(normalizedProject);
  const candidate = windowsPath ? normalizedPath.toLowerCase() : normalizedPath;
  const root = windowsPath ? normalizedProject.toLowerCase() : normalizedProject;
  return candidate === root || candidate.startsWith(`${root}/`);
}
