/**
 * #798: Per-page GitHub API fetching — root-cause fix for maxBuffer crash.
 *
 * Extracted from index.ts for testability (#805 review feedback).
 *
 * Replaced `--paginate` (buffers entire history into one stdout) with
 * per-page mode (100 items, 2MB maxBuffer each). Each page has bounded
 * size so buffer overflow is structurally impossible.
 *
 * Performance note: GitHub returns oldest-first and not all endpoints
 * support incremental cursors. Comment endpoints use a verified created_at
 * lower bound; review decisions still reread history because old reviews can be dismissed.
 */
import { commentSince } from './comment-since.js';
import { executeGitHubRequest, type GitHubRequestOptions } from './request-budget.js';

export interface FetchPaginatedOptions extends GitHubRequestOptions {
  /** Items with id > sinceId are collected. 0 or omitted = collect all. */
  sinceId?: number;
}

/**
 * Fetch all items from a paginated GitHub API endpoint.
 * Uses per-page mode (100 items/page, 2MB maxBuffer each) to avoid
 * single-buffer overflow on large PRs.
 *
 * Returns untyped array — callers cast items to their expected shape
 * (GitHub API JSON responses are untyped at this layer).
 */
// biome-ignore lint/suspicious/noExplicitAny: GitHub API JSON responses are untyped; callers cast inline
export async function fetchPaginated(endpoint: string, options: FetchPaginatedOptions = {}): Promise<any[]> {
  const cursor = options.sinceId ?? 0;
  options.signal?.throwIfAborted();
  const since = await commentSince(endpoint, cursor, options);
  // biome-ignore lint/suspicious/noExplicitAny: GitHub API JSON parse results
  const allItems: any[] = [];
  let page = 1;

  while (true) {
    options.signal?.throwIfAborted();
    const query = `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
    const { stdout } = await executeGitHubRequest(['api', query, '--jq', '.[]'], options);
    options.signal?.throwIfAborted();
    if (!stdout.trim()) break; // empty page = no more data

    const items = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (items.length === 0) break;

    const newItems = cursor > 0 ? items.filter((item: { id?: number }) => (item.id ?? 0) > cursor) : items;
    allItems.push(...newItems);

    // GitHub API max per_page is 100; fewer items = last page
    if (items.length < 100) break;
    page++;
  }
  return allItems;
}
