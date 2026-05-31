/**
 * #798: Per-page GitHub API fetching — root-cause fix for maxBuffer crash.
 *
 * Extracted from index.ts for testability (#805 review feedback).
 *
 * Replaced `--paginate` (buffers entire history into one stdout) with
 * per-page mode (100 items, 2MB maxBuffer each). Each page has bounded
 * size so buffer overflow is structurally impossible.
 *
 * NOTE: computePackChecksum() in governance-pack.ts is env-sensitive —
 * same git SHA with different env vars produces different checksums.
 *
 * Performance note: GitHub returns oldest-first and not all endpoints
 * support `since`/`direction` params, so we still scan all pages
 * client-side. A future optimization could use GraphQL `last:N`.
 */

export interface FetchPaginatedOptions {
  /** Items with id > sinceId are collected. 0 or omitted = collect all. */
  sinceId?: number;
  /** Override for testing — replaces real execFile */
  execFileAsync?: (
    file: string,
    args: string[],
    opts: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
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
  const { sinceId, execFileAsync: execOverride } = options;
  const execFn =
    execOverride ??
    (async (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      return promisify(execFile)(file, args, opts);
    });

  const cursor = sinceId ?? 0;
  // biome-ignore lint/suspicious/noExplicitAny: GitHub API JSON parse results
  const allItems: any[] = [];
  let page = 1;

  while (true) {
    const { stdout } = await execFn('gh', ['api', `${endpoint}?per_page=100&page=${page}`, '--jq', '.[]'], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
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
