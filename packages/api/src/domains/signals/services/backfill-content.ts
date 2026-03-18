import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SignalPaths } from '../config/signal-paths.js';
import { resolveSignalPaths } from '../config/signal-paths.js';
import { extractArticleBody } from '../fetchers/webpage-fetcher.js';

const VALID_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface BackfillResult {
  readonly source: string;
  readonly total: number;
  readonly empty: number;
  readonly filled: number;
  readonly failed: number;
  readonly details: readonly BackfillDetail[];
}

interface BackfillDetail {
  readonly file: string;
  readonly url: string;
  readonly status: 'filled' | 'failed' | 'skipped';
  readonly isEmpty: boolean;
  readonly reason?: string;
}

function parseFrontmatterBlock(raw: string): { fm: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const parsed = parseYaml(raw.slice(4, end));
  const fm =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { fm, body: raw.slice(end + 5) };
}

function isBodyEmpty(body: string): boolean {
  return body.replace(/^#\s+.*$/m, '').trim().length === 0;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CatCafe-Signal-Backfill/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function fetchAndWrite(
  filePath: string,
  url: string,
  fm: Record<string, unknown>,
  file: string,
): Promise<BackfillDetail> {
  const html = await fetchHtml(url);
  if (!html) return { file, url, status: 'failed', isEmpty: true, reason: 'fetch failed' };

  const content = extractArticleBody(html);
  if (!content) return { file, url, status: 'failed', isEmpty: true, reason: 'no extractable content' };

  const title = typeof fm.title === 'string' ? fm.title : file;
  const newRaw = `---\n${stringifyYaml(fm)}---\n# ${title}\n\n${content}\n`;
  await writeFile(filePath, newRaw, 'utf-8');

  return { file, url, status: 'filled', isEmpty: true };
}

function classifyFile(
  file: string,
  parsed: { fm: Record<string, unknown>; body: string },
  dryRun: boolean,
): BackfillDetail | { action: 'fetch'; url: string } {
  const url = typeof parsed.fm.url === 'string' ? parsed.fm.url : '';

  if (!isBodyEmpty(parsed.body)) {
    return { file, url, status: 'skipped', isEmpty: false, reason: 'has content' };
  }
  if (url.length === 0) {
    return { file, url, status: 'failed', isEmpty: true, reason: 'no url in frontmatter' };
  }
  if (dryRun) {
    return { file, url, status: 'skipped', isEmpty: true, reason: 'dry run' };
  }
  return { action: 'fetch', url };
}

function isDetail(v: BackfillDetail | { action: 'fetch'; url: string }): v is BackfillDetail {
  return 'status' in v;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

function summarize(details: readonly BackfillDetail[], sourceId: string, total: number): BackfillResult {
  let empty = 0;
  let filled = 0;
  let failed = 0;
  for (const d of details) {
    if (d.isEmpty) empty += 1;
    if (d.status === 'filled') filled += 1;
    if (d.status === 'failed' && d.isEmpty) failed += 1;
  }
  return { source: sourceId, total, empty, filled, failed, details };
}

export async function backfillSourceContent(
  sourceId: string,
  options: { paths?: SignalPaths; dryRun?: boolean } = {},
): Promise<BackfillResult> {
  if (!VALID_SOURCE_ID.test(sourceId)) {
    throw new Error(`Invalid source id: "${sourceId}"`);
  }
  const paths = options.paths ?? resolveSignalPaths();
  const sourceDir = join(paths.libraryDir, sourceId);
  const resolved = resolve(sourceDir);
  if (!resolved.startsWith(resolve(paths.libraryDir))) {
    throw new Error(`Invalid source id: "${sourceId}"`);
  }
  const files = await listMarkdownFiles(sourceDir);
  const emptyResult: BackfillResult = { source: sourceId, total: 0, empty: 0, filled: 0, failed: 0, details: [] };
  if (files.length === 0) return emptyResult;

  const details: BackfillDetail[] = [];

  for (const file of files) {
    const raw = await readFile(join(sourceDir, file), 'utf-8');
    const parsed = parseFrontmatterBlock(raw);
    if (!parsed) continue;

    const classification = classifyFile(file, parsed, options.dryRun ?? false);
    if (isDetail(classification)) {
      details.push(classification);
      continue;
    }

    const result = await fetchAndWrite(join(sourceDir, file), classification.url, parsed.fm, file);
    details.push(result);
  }

  return summarize(details, sourceId, files.length);
}
