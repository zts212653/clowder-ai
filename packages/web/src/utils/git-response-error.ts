export const GIT_WORKTREE_REQUIRED = 'git_worktree_required';
export const GIT_UNAVAILABLE = 'git_unavailable';

/** Preserve the server's machine-readable Git error code for UI copy. */
export async function readGitErrorCode(response: Response): Promise<string> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') {
    return body.code;
  }
  return response
    .clone()
    .text()
    .catch(() => '');
}

export function isGitWorktreeRequired(error: string | null | undefined): boolean {
  return error === GIT_WORKTREE_REQUIRED;
}
