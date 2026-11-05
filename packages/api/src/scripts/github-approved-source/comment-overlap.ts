import type { SourceScope } from './approved-scope.js';
import { readProviderOverlap } from './comment-window-provider.js';
import type { Reader } from './eligible-task.js';

export type ReadOverlap = (repo: string, cursor: string, signal: AbortSignal) => Promise<readonly string[]>;
function seenPage(result: unknown, repo: string): [string, string[]] {
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== 'string' ||
    !/^\d+$/.test(result[0]) ||
    !Array.isArray(result[1]) ||
    result[1].some((x) => typeof x !== 'string' || !x.startsWith(`comment:${repo}#`))
  )
    throw new Error('Invalid original seen page');
  return result as [string, string[]];
}
/** Project the old seen set onto the consumer's one-second cursor overlap.
 * Read every original set page into the census; never fabricate a seen ID. */
export function commentOverlapReader(
  reader: Reader,
  scope: SourceScope,
  signal: AbortSignal,
  fetchWindow: ReadOverlap = readProviderOverlap,
) {
  const cursors = new Map<string, string | null>();
  const windows = new Map<string, ReadonlySet<string>>();
  const seen = new Map<string, Set<string>>(),
    retained = new Map<string, Set<string>>();
  function captureCursor(key: string | undefined, result: unknown) {
    const repo = scope.repositories.find((r) => key === `${scope.keyPrefix}community:repo-comment:cursor:${r}`);
    if (!repo) return;
    if (result !== null && (typeof result !== 'string' || !Number.isFinite(Date.parse(result))))
      throw new Error('Invalid original comment cursor');
    cursors.set(repo, result as string | null);
  }
  async function window(repo: string, cursor: string) {
    const existing = windows.get(repo);
    if (existing) return existing;
    const ids = await fetchWindow(repo, cursor, signal);
    const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (ids.some((id) => !new RegExp(`^comment:${escaped}#[1-9]\\d*:[1-9]\\d*$`).test(id)))
      throw new Error('Unscoped provider overlap evidence');
    const complete = new Set(ids);
    windows.set(repo, complete);
    return complete;
  }
  async function project(args: string[], result: unknown) {
    const repo = scope.repositories.find((r) => args[3] === `comment:${r}#*`);
    const cursor = repo ? cursors.get(repo) : undefined;
    if (!repo || cursor === undefined) throw new Error('Comment window requires its original cursor');
    const [next, ids] = seenPage(result, repo);
    if (cursor === null) return result; // Stock behavior when no cursor ever existed.
    const needed = await window(repo, cursor);
    const all = seen.get(repo) ?? new Set<string>(),
      kept = retained.get(repo) ?? new Set<string>();
    const selected: string[] = [];
    for (const id of ids) {
      all.add(id);
      if (needed.has(id)) {
        selected.push(id);
        kept.add(id);
      }
    }
    seen.set(repo, all);
    retained.set(repo, kept);
    return [next, selected];
  }
  return {
    reader: {
      async read(command: string, ...args: string[]): Promise<unknown> {
        const result = await reader.read(command, ...args);
        if (command === 'GET') captureCursor(args[0], result);
        return command === 'SSCAN' && args[0] === `${scope.keyPrefix}community:events:seen`
          ? project(args, result)
          : result;
      },
    } satisfies Reader,
    census: () =>
      [...cursors]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([repo, cursor]) => ({
          repo,
          cursor,
          originalSeenIds: [...(seen.get(repo) ?? [])].sort(),
          retainedOverlapIds: [...(retained.get(repo) ?? [])].sort(),
        })),
  };
}
