/** Return the final directory segment for POSIX and Windows worktree paths. */
export function worktreeBasename(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** Format a worktree or linked root without losing its user-facing alias. */
export function worktreeLabel(worktree: { head: string; root: string; branch: string }): string {
  const basename = worktreeBasename(worktree.root);
  return worktree.head === 'linked'
    ? `📂 ${basename} — ${worktree.branch}`
    : `${basename} — ${worktree.branch} (${worktree.head})`;
}
