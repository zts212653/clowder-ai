import type { SignalArticle, SignalSource, SignalSourceConfig } from '@cat-cafe/shared';
import type { FetchError, FetchErrorCode, Fetcher, FetchResult } from '../fetchers/types.js';
import type { StoreArticleInput } from './article-store.js';

export interface DeduplicationLike {
  checkAndMark(url: string): {
    readonly articleId: string;
    readonly isNew: boolean;
  };
  unmark?(url: string): void;
}

export interface ArticleStoreLike {
  store(input: StoreArticleInput): Promise<SignalArticle>;
}

export interface SourceProcessingResult {
  readonly errors: readonly FetchError[];
  readonly fetchedArticles: number;
  readonly duplicateArticles: number;
  readonly storedArticles: readonly SignalArticle[];
}

function isSourceScheduledForAutomaticRun(source: SignalSource, now: Date): boolean {
  if (!source.enabled) return false;

  const frequency = source.schedule.frequency;
  if (frequency === 'manual') return false;
  if (frequency === 'weekly') return now.getDay() === 1;
  return true;
}

function createFetchError(code: FetchErrorCode, sourceId: string, message: string): FetchError {
  return {
    code,
    sourceId,
    message,
  };
}

function toFailureCode(method: 'rss' | 'api' | 'webpage'): FetchErrorCode {
  if (method === 'rss') return 'RSS_FETCH_FAILED';
  if (method === 'api') return 'API_FETCH_FAILED';
  return 'WEBPAGE_FETCH_FAILED';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeKeywords(keywords: readonly string[] | undefined): readonly string[] {
  if (!keywords) return [];
  return keywords.map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword.length > 0);
}

function buildKeywordHaystack(article: FetchResult['articles'][number]): string {
  return [article.title, article.summary, article.content, article.url]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
}

function shouldKeepArticleByKeywordFilter(source: SignalSource, article: FetchResult['articles'][number]): boolean {
  const includeKeywords = normalizeKeywords(source.filters?.keywords?.include);
  const excludeKeywords = normalizeKeywords(source.filters?.keywords?.exclude);
  if (includeKeywords.length === 0 && excludeKeywords.length === 0) {
    return true;
  }

  const haystack = buildKeywordHaystack(article);
  if (includeKeywords.length > 0 && !includeKeywords.some((keyword) => haystack.includes(keyword))) {
    return false;
  }
  if (excludeKeywords.length > 0 && excludeKeywords.some((keyword) => haystack.includes(keyword))) {
    return false;
  }

  return true;
}

function filterArticlesByKeywordFilter(
  source: SignalSource,
  articles: readonly FetchResult['articles'][number][],
): readonly FetchResult['articles'][number][] {
  return articles.filter((article) => shouldKeepArticleByKeywordFilter(source, article));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Feeds that ship their whole archive would otherwise flood the inbox on a first run. */
function filterArticlesByMaxAge(
  source: SignalSource,
  articles: readonly FetchResult['articles'][number][],
  now: Date,
): readonly FetchResult['articles'][number][] {
  const maxAgeDays = source.filters?.maxAgeDays;
  if (!maxAgeDays) return articles;

  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  return articles.filter((article) => {
    const publishedAt = Date.parse(article.publishedAt);
    // An unparseable date cannot prove the article is stale, so keep it.
    return Number.isNaN(publishedAt) || publishedAt >= cutoff;
  });
}

export function selectSources(
  config: SignalSourceConfig,
  sourceId: string | undefined,
  now: Date = new Date(),
): readonly SignalSource[] {
  if (!sourceId) {
    return config.sources.filter((source) => isSourceScheduledForAutomaticRun(source, now));
  }

  const matched = config.sources.find((source) => source.id === sourceId);
  if (!matched) {
    throw new Error(`source "${sourceId}" not found in sources config`);
  }
  return [matched];
}

async function fetchSourceResult(source: SignalSource, fetcher: Fetcher): Promise<FetchResult | FetchError> {
  try {
    return await fetcher.fetch(source);
  } catch (error) {
    return createFetchError(
      toFailureCode(source.fetch.method),
      source.id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function storeFetchedArticles(params: {
  source: SignalSource;
  articles: readonly FetchResult['articles'][number][];
  fetchedAt: string;
  dryRun: boolean;
  deduplication: DeduplicationLike;
  articleStore: ArticleStoreLike;
}): Promise<Pick<SourceProcessingResult, 'errors' | 'duplicateArticles' | 'storedArticles'>> {
  const errors: FetchError[] = [];
  const storedArticles: SignalArticle[] = [];
  let duplicateArticles = 0;

  for (const rawArticle of params.articles) {
    const dedup = params.deduplication.checkAndMark(rawArticle.url);
    if (!dedup.isNew) {
      duplicateArticles += 1;
      continue;
    }

    if (params.dryRun) continue;

    try {
      const stored = await params.articleStore.store({
        source: params.source,
        article: rawArticle,
        articleId: dedup.articleId,
        fetchedAt: params.fetchedAt,
      });
      storedArticles.push(stored);
    } catch (error) {
      // Roll back this run's dedup mark so a later copy of the same URL can still be stored.
      params.deduplication.unmark?.(rawArticle.url);
      errors.push(
        createFetchError(
          toFailureCode(params.source.fetch.method),
          params.source.id,
          `failed to store article "${rawArticle.url}": ${toErrorMessage(error)}`,
        ),
      );
    }
  }

  return {
    errors,
    duplicateArticles,
    storedArticles,
  };
}

async function processSource(params: {
  source: SignalSource;
  fetchers: readonly Fetcher[];
  dryRun: boolean;
  deduplication: DeduplicationLike;
  articleStore: ArticleStoreLike;
  now: Date;
}): Promise<SourceProcessingResult> {
  const fetcher = params.fetchers.find((candidate) => candidate.canHandle(params.source));
  if (!fetcher) {
    return {
      errors: [
        createFetchError('UNSUPPORTED_SOURCE', params.source.id, `no fetcher supports source "${params.source.id}"`),
      ],
      fetchedArticles: 0,
      duplicateArticles: 0,
      storedArticles: [],
    };
  }

  const fetched = await fetchSourceResult(params.source, fetcher);
  if ('code' in fetched) {
    return {
      errors: [fetched],
      fetchedArticles: 0,
      duplicateArticles: 0,
      storedArticles: [],
    };
  }

  const filteredArticles = filterArticlesByMaxAge(
    params.source,
    filterArticlesByKeywordFilter(params.source, fetched.articles),
    params.now,
  );
  const stored = await storeFetchedArticles({
    source: params.source,
    articles: filteredArticles,
    fetchedAt: fetched.metadata.fetchedAt,
    dryRun: params.dryRun,
    deduplication: params.deduplication,
    articleStore: params.articleStore,
  });

  return {
    errors: [...fetched.errors, ...stored.errors],
    fetchedArticles: filteredArticles.length,
    duplicateArticles: stored.duplicateArticles,
    storedArticles: stored.storedArticles,
  };
}

export async function processSources(params: {
  sources: readonly SignalSource[];
  fetchers: readonly Fetcher[];
  dryRun: boolean;
  deduplication: DeduplicationLike;
  articleStore: ArticleStoreLike;
  /** Clock for maxAgeDays filtering; the scheduler passes its own. */
  now?: Date | undefined;
}): Promise<{
  readonly errors: readonly FetchError[];
  readonly fetchedArticles: number;
  readonly duplicateArticles: number;
  readonly storedArticles: readonly SignalArticle[];
}> {
  const errors: FetchError[] = [];
  const storedArticles: SignalArticle[] = [];
  let fetchedArticles = 0;
  let duplicateArticles = 0;

  const now = params.now ?? new Date();

  for (const source of params.sources) {
    const sourceResult = await processSource({
      source,
      fetchers: params.fetchers,
      dryRun: params.dryRun,
      deduplication: params.deduplication,
      articleStore: params.articleStore,
      now,
    });

    errors.push(...sourceResult.errors);
    fetchedArticles += sourceResult.fetchedArticles;
    duplicateArticles += sourceResult.duplicateArticles;
    storedArticles.push(...sourceResult.storedArticles);
  }

  return {
    errors,
    fetchedArticles,
    duplicateArticles,
    storedArticles,
  };
}
