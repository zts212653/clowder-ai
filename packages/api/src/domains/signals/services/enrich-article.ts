import type { SignalPaths } from '../config/signal-paths.js';
import { extractArticleBody } from '../fetchers/webpage-fetcher.js';
import type { SignalArticleDetail } from './article-document.js';
import { readArticleDocument, toUpdatedFrontmatter, writeArticleDocument } from './article-document.js';
import { readInboxRecords } from './inbox-records.js';

interface FetchResult {
  html: string | null;
  status: number | null;
  error?: string;
}

async function fetchHtml(url: string): Promise<FetchResult> {
  try {
    const res = await globalThis.fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { html: null, status: res.status };
    return { html: await res.text(), status: res.status };
  } catch (err) {
    return { html: null, status: null, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

export interface EnrichResult {
  article: SignalArticleDetail;
  enriched: boolean;
  reason?: string;
}

export async function enrichArticleContent(articleId: string, paths: SignalPaths): Promise<EnrichResult | null> {
  const records = await readInboxRecords(paths, undefined);
  const record = records.find((r) => r.id === articleId);
  if (!record) return null;

  const doc = await readArticleDocument(record);
  const mkDetail = (content: string): SignalArticleDetail => ({ ...doc.article, content });

  if (doc.frontmatter.enriched === true) {
    return { article: mkDetail(doc.content), enriched: false, reason: 'already_enriched' };
  }

  const result = await fetchHtml(doc.article.url);
  if (!result.html) {
    const reason = result.status ? `fetch_${result.status}` : `network_error: ${result.error ?? 'unknown'}`;
    return { article: mkDetail(doc.content), enriched: false, reason };
  }

  const extracted = extractArticleBody(result.html);
  const currentBody = doc.content.replace(/^#\s+.*$/m, '').trim();

  if (extracted && extracted.length > currentBody.length) {
    const newContent = `# ${doc.article.title}\n\n${extracted}`;
    const fm = { ...toUpdatedFrontmatter(doc.frontmatter, doc.article), enriched: true };
    await writeArticleDocument({ filePath: doc.article.filePath, frontmatter: fm, content: newContent });
    return { article: mkDetail(newContent), enriched: true };
  }

  const fm = { ...toUpdatedFrontmatter(doc.frontmatter, doc.article), enriched: true };
  await writeArticleDocument({ filePath: doc.article.filePath, frontmatter: fm, content: doc.content });
  return { article: mkDetail(doc.content), enriched: false, reason: 'no_better_content' };
}
