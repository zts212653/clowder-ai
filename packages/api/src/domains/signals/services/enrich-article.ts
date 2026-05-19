import type { SignalPaths } from '../config/signal-paths.js';
import { extractArticleBody } from '../fetchers/webpage-fetcher.js';
import { readArticleDocument, writeArticleDocument } from './article-document.js';
import { type InboxRecord, readInboxRecords } from './inbox-records.js';

export interface EnrichResult {
  readonly enriched: boolean;
  readonly reason?: 'already_enriched' | 'no_better_content' | 'fetch_failed' | 'not_found';
  readonly contentLength?: number;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CatCafe-Signal-Enrich/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export async function enrichArticleContent(articleId: string, paths: SignalPaths): Promise<EnrichResult> {
  const records = await readInboxRecords(paths, undefined);
  const matched: InboxRecord | undefined = records.find((r) => r.id === articleId);
  if (!matched) {
    return { enriched: false, reason: 'not_found' };
  }

  const doc = await readArticleDocument(matched);
  if (doc.frontmatter.enriched === true) {
    return { enriched: false, reason: 'already_enriched', contentLength: doc.content.length };
  }

  const html = await fetchHtml(matched.url);
  if (!html) {
    return { enriched: false, reason: 'fetch_failed' };
  }

  const extracted = extractArticleBody(html);
  if (!extracted || extracted.length <= doc.content.length) {
    await writeArticleDocument({
      filePath: matched.filePath,
      frontmatter: { ...doc.frontmatter, enriched: true },
      content: doc.content,
    });
    return { enriched: false, reason: 'no_better_content', contentLength: doc.content.length };
  }

  await writeArticleDocument({
    filePath: matched.filePath,
    frontmatter: { ...doc.frontmatter, enriched: true },
    content: extracted,
  });

  return { enriched: true, contentLength: extracted.length };
}
