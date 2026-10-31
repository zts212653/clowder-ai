import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type ReadPage = (repo: string, since: string, page: number, signal: AbortSignal) => Promise<unknown>;
async function metadataPage(repo: string, since: string, page: number, signal: AbortSignal) {
  const query = new URLSearchParams({ since, sort: 'updated', direction: 'asc', per_page: '100', page: String(page) });
  try {
    const { stdout } = await execute(
      'gh',
      ['api', `repos/${repo}/issues/comments?${query}`, '--jq', 'map({id,updated_at,issue_url})'],
      { signal, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    return JSON.parse(stdout) as unknown;
  } catch {
    signal.throwIfAborted();
    throw new Error('Comment overlap metadata unavailable; no incomplete window may be imported');
  }
}
function commentId(row: unknown, repo: string, since: string): [number, string] {
  if (!row || typeof row !== 'object' || Object.keys(row).some((k) => !['id', 'updated_at', 'issue_url'].includes(k)))
    throw new Error('Unexpected comment metadata field');
  const value = row as { id?: unknown; updated_at?: unknown; issue_url?: unknown };
  const prefix = `https://api.github.com/repos/${repo}/issues/`;
  const number =
    typeof value.issue_url === 'string' && value.issue_url.startsWith(prefix)
      ? value.issue_url.slice(prefix.length)
      : '';
  if (
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    Date.parse(value.updated_at) < Date.parse(since) ||
    !/^[1-9]\d*$/.test(number)
  )
    throw new Error('Comment window metadata escaped its repository or time window');
  return [value.id, `comment:${repo}#${number}:${value.id}`];
}
/** Same complete one-second overlap as the ordinary collector. Only metadata
 * crosses stdout; no body, token, author or title enters the source envelope. */
export async function readProviderOverlap(
  repo: string,
  cursor: string,
  signal: AbortSignal,
  readPage: ReadPage = metadataPage,
) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) || !Number.isFinite(Date.parse(cursor)))
    throw new Error('Invalid approved comment window');
  const since = new Date(Date.parse(cursor) - 1000).toISOString();
  const found = new Map<number, string>();
  for (let page = 1; page <= 20; page++) {
    signal.throwIfAborted();
    const rows = await readPage(repo, since, page, signal);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid comment window page');
    for (const row of rows) {
      const [id, eventId] = commentId(row, repo, since);
      if (found.has(id)) throw new Error('Comment window pagination changed');
      found.set(id, eventId);
    }
    if (rows.length < 100) return [...found.values()];
  }
  throw new Error('Comment window pagination incomplete');
}
