import type { SignalSource } from '@cat-cafe/shared';
import Parser from 'rss-parser';
import type { FetchError, Fetcher, FetchResult, RawArticle } from './types.js';

interface RssItem {
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly guid?: string | undefined;
  readonly pubDate?: string | undefined;
  readonly isoDate?: string | undefined;
  readonly contentSnippet?: string | undefined;
  readonly content?: string | undefined;
}

interface RssFeed {
  readonly items?: readonly RssItem[] | undefined;
}

interface RssParserLike {
  parseString(xml: string): Promise<RssFeed>;
}

interface TextResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export interface RssFetchOptions {
  readonly headers?: Record<string, string> | undefined;
  readonly signal?: AbortSignal | undefined;
}

type FetchLike = (url: string, options?: RssFetchOptions) => Promise<TextResponseLike>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** The headers rss-parser sent when it requested feeds itself, so servers see the same client. */
const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'rss-parser',
  Accept: 'application/rss+xml',
};

function nowIso(): string {
  return new Date().toISOString();
}

function isSupportedHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function toRawArticle(item: RssItem): RawArticle | null {
  const normalizedLink = item.link?.trim();
  const normalizedGuid = item.guid?.trim();
  const url = [normalizedLink, normalizedGuid].find((candidate) => {
    if (!candidate) return false;
    return isSupportedHttpUrl(candidate);
  });
  const title = item.title?.trim();
  if (!url || !title) return null;

  return {
    url,
    title,
    publishedAt: item.isoDate ?? item.pubDate ?? nowIso(),
    summary: item.contentSnippet?.trim() || undefined,
    content: item.content?.trim() || undefined,
  };
}

function unsupportedSourceError(source: SignalSource): FetchError {
  return {
    code: 'UNSUPPORTED_SOURCE',
    message: `source "${source.id}" is not an RSS source`,
    sourceId: source.id,
  };
}

export class RssFetcher implements Fetcher {
  private readonly fetchImpl: FetchLike;
  private readonly parser: RssParserLike;

  constructor(fetchImpl?: FetchLike, parser?: RssParserLike) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.parser = parser ?? new Parser();
  }

  canHandle(source: SignalSource): boolean {
    return source.fetch.method === 'rss';
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

    // The request is made here instead of rss-parser's parseURL: parseURL never reads
    // redirect responses and does not abort on its timeout, so the leftover keep-alive
    // sockets held one-shot fetch runs open for minutes. rss-parser only parses now.
    const timeoutMs = source.fetch.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(source.url, {
        headers: { ...DEFAULT_HEADERS, ...source.fetch.headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const feed = await this.parser.parseString(await response.text());
      const articles = (feed.items ?? []).map(toRawArticle).filter((item): item is RawArticle => item !== null);

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
      const message = controller.signal.aborted
        ? `request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      return {
        articles: [],
        errors: [
          {
            code: 'RSS_FETCH_FAILED',
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
      // Release the connection on every exit path: a body left unread (error status, parse
      // failure) otherwise keeps its socket open. After a fully read body this is a no-op.
      controller.abort();
    }
  }
}
