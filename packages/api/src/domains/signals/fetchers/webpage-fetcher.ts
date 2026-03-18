import type { SignalSource } from '@cat-cafe/shared';
import { load } from 'cheerio';
import type { FetchError, Fetcher, FetchResult, RawArticle } from './types.js';

interface HtmlResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export interface HtmlFetchOptions {
  readonly headers?: Record<string, string> | undefined;
  readonly signal?: AbortSignal | undefined;
}

type FetchLike = (url: string, options?: HtmlFetchOptions) => Promise<HtmlResponseLike>;

const DEFAULT_TIMEOUT_MS = 15_000;

function nowIso(): string {
  return new Date().toISOString();
}

function unsupportedSourceError(source: SignalSource): FetchError {
  return {
    code: 'UNSUPPORTED_SOURCE',
    message: `source "${source.id}" is not a webpage source`,
    sourceId: source.id,
  };
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveAbsoluteUrl(href: string, sourceUrl: string): string {
  try {
    return new URL(href, sourceUrl).toString();
  } catch {
    return href.trim();
  }
}

function resolveHref(element: ReturnType<ReturnType<typeof load>>, source: SignalSource): string | undefined {
  const selfHref = normalizeText(element.attr('href'));
  if (selfHref) return resolveAbsoluteUrl(selfHref, source.url);

  const childHref = normalizeText(element.find('a[href]').first().attr('href'));
  if (childHref) return resolveAbsoluteUrl(childHref, source.url);

  return undefined;
}

function extractBodyParts($: ReturnType<typeof load>, element: ReturnType<typeof $>, title: string): string[] {
  const parts: string[] = [];
  element.find('p, li, blockquote, pre, td, dd').each((_, el) => {
    const text = normalizeText($(el).text());
    if (text && text !== title) parts.push(text);
  });
  return parts;
}

function parseWebpageArticles(html: string, source: SignalSource, fetchedAt: string): readonly RawArticle[] {
  const selector = source.fetch.selector?.trim();
  if (!selector) {
    throw new Error(`webpage source "${source.id}" requires fetch.selector`);
  }

  const $ = load(html);
  const nodes = $(selector).toArray();
  const articles: RawArticle[] = [];

  for (const node of nodes) {
    const element = $(node);
    const headingText = normalizeText(element.find('h1,h2,h3,h4,h5,h6').first().text());
    const childAnchor = element.find('a[href]').first();
    const anchorText = normalizeText(childAnchor.text());
    const title = headingText ?? anchorText ?? normalizeText(element.text());
    const url = resolveHref(element, source);

    if (!title || !url) continue;

    const publishedAt = normalizeText(element.find('time[datetime]').first().attr('datetime')) ?? fetchedAt;
    const summary = normalizeText(element.find('p').first().text());
    const bodyParts = extractBodyParts($, element, title);
    const content = bodyParts.length > 0 ? bodyParts.join('\n\n') : undefined;

    articles.push({
      url,
      title,
      publishedAt,
      ...(summary ? { summary } : {}),
      ...(content ? { content } : {}),
    });
  }

  return articles;
}

export function extractArticleBody(html: string): string | undefined {
  const $ = load(html);
  const container = $('article').first().length > 0 ? $('article').first() : $('main').first();
  if (container.length === 0) return undefined;

  const parts: string[] = [];
  container.find('p, li, blockquote, pre, td, dd').each((_, el) => {
    const text = normalizeText($(el).text());
    if (text) parts.push(text);
  });
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

const MAX_SECONDARY_FETCHES = 30;

async function fetchArticleContent(
  fetchImpl: FetchLike,
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { headers, signal });
    if (!response.ok) return undefined;
    const html = await response.text();
    return extractArticleBody(html);
  } catch {
    return undefined;
  }
}

export class WebpageFetcher implements Fetcher {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  canHandle(source: SignalSource): boolean {
    return source.fetch.method === 'webpage';
  }

  private async enrichWithSecondaryFetch(
    articles: readonly RawArticle[],
    source: SignalSource,
    signal?: AbortSignal,
  ): Promise<readonly RawArticle[]> {
    const needsFetch = articles.filter((a) => !a.content);
    if (needsFetch.length === 0) return articles;

    const toFetch = needsFetch.slice(0, MAX_SECONDARY_FETCHES);
    const contentMap = new Map<string, string>();

    await Promise.all(
      toFetch.map(async (article) => {
        const body = await fetchArticleContent(this.fetchImpl, article.url, source.fetch.headers, signal);
        if (body) contentMap.set(article.url, body);
      }),
    );

    return articles.map((article) => {
      if (article.content) return article;
      const body = contentMap.get(article.url);
      if (!body) return article;
      return { ...article, content: body };
    });
  }

  async fetch(source: SignalSource): Promise<FetchResult> {
    const start = Date.now();
    const fetchedAt = nowIso();

    if (!this.canHandle(source)) {
      return {
        articles: [],
        errors: [unsupportedSourceError(source)],
        metadata: {
          fetchedAt,
          duration: Date.now() - start,
          source: source.id,
        },
      };
    }

    const timeoutMs = source.fetch.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(source.url, {
        headers: source.fetch.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const parsed = parseWebpageArticles(html, source, fetchedAt);
      const articles = await this.enrichWithSecondaryFetch(parsed, source, controller.signal);

      return {
        articles,
        errors: [],
        metadata: {
          fetchedAt,
          duration: Date.now() - start,
          source: source.id,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        articles: [],
        errors: [
          {
            code: 'WEBPAGE_FETCH_FAILED',
            message,
            sourceId: source.id,
          },
        ],
        metadata: {
          fetchedAt,
          duration: Date.now() - start,
          source: source.id,
        },
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
