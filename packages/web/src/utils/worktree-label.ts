/**
 * Format a worktree or linked-root entry for selector dropdowns.
 *
 * Linked roots show: 📂 basename — alias
 * Worktrees show:    basename — branch (head)
 *
 * The alias (stored in `branch` for linked roots) is always included
 * to disambiguate entries with the same directory basename (#1117).
 */
export function worktreeLabel(w: { head: string; root: string; branch: string }): string {
  const basename = w.root.split(/[\\/]/).pop();
  return w.head === 'linked' ? `📂 ${basename} — ${w.branch}` : `${basename} — ${w.branch} (${w.head})`;
}
