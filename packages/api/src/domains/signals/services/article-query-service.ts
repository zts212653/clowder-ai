import type { SignalArticle, SignalArticleStatus, SignalTier } from '@cat-cafe/shared';
import { SignalArticleSchema } from '@cat-cafe/shared';
import type { SignalPaths } from '../config/signal-paths.js';
import { resolveSignalPaths } from '../config/signal-paths.js';
import {
  type ParsedArticleDocument,
  readArticleDocument as readArticleDocumentFromStore,
  type SignalArticleDetail,
  toUpdatedFrontmatter,
  writeArticleDocument,
} from './article-document.js';
import { computeSignalArticleStats, type SignalArticleStats } from './article-stats.js';
import { normalizeArticleUrl } from './deduplication.js';
import { type InboxRecord, readInboxRecords as readInboxRecordsFromStore } from './inbox-records.js';
import { StudyMetaService } from './study-meta-service.js';

export type { SignalArticleDetail } from './article-document.js';

export interface ListInboxOptions {
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly source?: string | undefined;
  readonly tier?: SignalTier | undefined;
  readonly status?: SignalArticleStatus | 'all' | undefined;
}

export interface SearchSignalArticlesOptions {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly status?: SignalArticleStatus | undefined;
  readonly source?: string | undefined;
  readonly tier?: SignalTier | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
}

export interface UpdateSignalArticleInput {
  readonly status?: SignalArticleStatus | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly note?: string | undefined;
  readonly deletedAt?: string | undefined;
}

function withinDateRange(targetIso: string, from: string | undefined, to: string | undefined): boolean {
  const target = Date.parse(targetIso);
  if (Number.isNaN(target)) {
    return false;
  }

  const fromValue = toDateBound(from, Number.NEGATIVE_INFINITY, 'start');
  const toValue = toDateBound(to, Number.POSITIVE_INFINITY, 'end');

  return target >= fromValue && target <= toValue;
}

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INBOX_LIMIT = 20;
const INBOX_RECORD_SCAN_MULTIPLIER = 20;
const MIN_INBOX_RECORD_SCAN_BUDGET = 200;

function toDateBound(value: string | undefined, fallback: number, mode: 'start' | 'end'): number {
  if (!value) {
    return fallback;
  }
  const input = value.trim();
  if (input.length === 0) {
    return fallback;
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  if (mode === 'end' && ISO_DAY_PATTERN.test(input)) {
    return parsed + DAY_IN_MS - 1;
  }
  return parsed;
}

async function enrichWithStudyMeta(article: SignalArticle, studyMeta: StudyMetaService): Promise<SignalArticle> {
  const meta = await studyMeta.readMeta(article.id, article.filePath);
  const studyCount = meta.threads.length + meta.artifacts.length;
  if (studyCount === 0 && !meta.lastStudiedAt) {
    return article;
  }
  return {
    ...article,
    studyCount,
    ...(meta.lastStudiedAt ? { lastStudiedAt: meta.lastStudiedAt } : {}),
  };
}

async function readArticleDetailsSafely(
  records: readonly InboxRecord[],
  readArticleDocumentFn: typeof readArticleDocumentFromStore,
): Promise<readonly ParsedArticleDocument[]> {
  const settled = await Promise.allSettled(records.map((record) => readArticleDocumentFn(record)));
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function readArticleDetailOrNull(
  record: InboxRecord,
  readArticleDocumentFn: typeof readArticleDocumentFromStore,
): Promise<ParsedArticleDocument | null> {
  try {
    return await readArticleDocumentFn(record);
  } catch {
    return null;
  }
}

function normalizeInboxLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INBOX_LIMIT;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : DEFAULT_INBOX_LIMIT;
}

async function selectInboxArticles(
  records: readonly InboxRecord[],
  options: ListInboxOptions,
  limit: number,
  readArticleDocumentFn: typeof readArticleDocumentFromStore,
): Promise<readonly SignalArticle[]> {
  const sortedRecords = [...records].sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt));
  const selected: SignalArticle[] = [];

  for (const record of sortedRecords) {
    if (options.source && record.source !== options.source) {
      continue;
    }
    if (options.tier && record.tier !== options.tier) {
      continue;
    }

    const detail = await readArticleDetailOrNull(record, readArticleDocumentFn);
    if (!detail) {
      continue;
    }

    const article = detail.article;
    if (article.deletedAt) {
      continue;
    }
    const wantedStatus = options.status ?? 'inbox';
    if (wantedStatus !== 'all' && article.status !== wantedStatus) {
      continue;
    }
    if (options.source && article.source !== options.source) {
      continue;
    }
    if (options.tier && article.tier !== options.tier) {
      continue;
    }

    selected.push(article);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt));
}

interface SignalArticleQueryDeps {
  readonly readInboxRecords: typeof readInboxRecordsFromStore;
  readonly readArticleDocument: typeof readArticleDocumentFromStore;
}

export class SignalArticleQueryService {
  private readonly paths: SignalPaths;
  private readonly deps: SignalArticleQueryDeps;
  private readonly studyMeta: StudyMetaService;

  constructor(options?: { paths?: SignalPaths | undefined; deps?: Partial<SignalArticleQueryDeps> | undefined }) {
    this.paths = options?.paths ?? resolveSignalPaths();
    this.deps = {
      readInboxRecords: options?.deps?.readInboxRecords ?? readInboxRecordsFromStore,
      readArticleDocument: options?.deps?.readArticleDocument ?? readArticleDocumentFromStore,
    };
    this.studyMeta = new StudyMetaService();
  }

  async listInbox(options: ListInboxOptions = {}): Promise<readonly SignalArticle[]> {
    const limit = normalizeInboxLimit(options.limit);
    const dateInput = options.date?.trim();
    const date = dateInput && dateInput.length > 0 ? dateInput : undefined;
    if (date) {
      const records = await this.deps.readInboxRecords(this.paths, date);
      const articles = await selectInboxArticles(records, options, limit, this.deps.readArticleDocument);
      return Promise.all(articles.map((a) => enrichWithStudyMeta(a, this.studyMeta)));
    }

    const scanBudget = Math.max(limit * INBOX_RECORD_SCAN_MULTIPLIER, MIN_INBOX_RECORD_SCAN_BUDGET);
    const probeLimit = scanBudget + 1;
    const sampledRecords = await this.deps.readInboxRecords(this.paths, undefined, { maxRecords: probeLimit });
    const hasMoreHistory = sampledRecords.length > scanBudget;
    const initialRecords = hasMoreHistory
      ? [...sampledRecords]
          .sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt))
          .slice(0, scanBudget)
      : sampledRecords;

    let selected = await selectInboxArticles(initialRecords, options, limit, this.deps.readArticleDocument);
    if (selected.length >= limit || !hasMoreHistory) {
      return Promise.all(selected.map((a) => enrichWithStudyMeta(a, this.studyMeta)));
    }

    const allRecords = await this.deps.readInboxRecords(this.paths, undefined);
    selected = await selectInboxArticles(allRecords, options, limit, this.deps.readArticleDocument);
    return Promise.all(selected.map((a) => enrichWithStudyMeta(a, this.studyMeta)));
  }

  async getArticleById(id: string): Promise<SignalArticleDetail | null> {
    const records = await this.deps.readInboxRecords(this.paths, undefined);
    const matched = records.find((record) => record.id === id);
    if (!matched) {
      return null;
    }

    const detail = await readArticleDetailOrNull(matched, this.deps.readArticleDocument);
    if (!detail) {
      return null;
    }
    const enriched = await enrichWithStudyMeta(detail.article, this.studyMeta);
    return {
      ...enriched,
      content: detail.content,
    };
  }

  async getArticleByUrl(url: string): Promise<SignalArticleDetail | null> {
    const input = url.trim();
    if (input.length === 0) {
      return null;
    }

    const normalized = normalizeArticleUrl(input);
    const records = await this.deps.readInboxRecords(this.paths, undefined);
    const matched = records.find((record) => normalizeArticleUrl(record.url) === normalized);
    if (!matched) {
      return null;
    }

    const detail = await readArticleDetailOrNull(matched, this.deps.readArticleDocument);
    if (!detail) {
      return null;
    }
    const enriched = await enrichWithStudyMeta(detail.article, this.studyMeta);
    return {
      ...enriched,
      content: detail.content,
    };
  }

  async search(
    options: SearchSignalArticlesOptions,
  ): Promise<{ readonly total: number; readonly items: readonly SignalArticle[] }> {
    const query = options.query.trim().toLowerCase();
    if (query.length === 0) {
      return {
        total: 0,
        items: [],
      };
    }

    const records = await this.deps.readInboxRecords(this.paths, undefined);
    const details = await readArticleDetailsSafely(records, this.deps.readArticleDocument);

    const matched = details
      .filter((detail) => !detail.article.deletedAt)
      .filter((detail) => (options.status ? detail.article.status === options.status : true))
      .filter((detail) => (options.source ? detail.article.source === options.source : true))
      .filter((detail) => (options.tier ? detail.article.tier === options.tier : true))
      .filter((detail) => withinDateRange(detail.article.fetchedAt, options.dateFrom, options.dateTo))
      .filter((detail) => {
        const haystacks = [
          detail.article.title,
          detail.article.url,
          detail.article.source,
          detail.article.summary ?? '',
          detail.article.note ?? '',
          ...detail.article.tags,
          detail.content,
        ].map((value) => value.toLowerCase());
        return haystacks.some((value) => value.includes(query));
      })
      .map((detail) => detail.article)
      .sort((left, right) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt));

    const limit = options.limit ?? 20;
    const enriched = await Promise.all(matched.slice(0, limit).map((a) => enrichWithStudyMeta(a, this.studyMeta)));
    return {
      total: matched.length,
      items: enriched,
    };
  }

  async updateArticle(id: string, input: UpdateSignalArticleInput): Promise<SignalArticleDetail | null> {
    const records = await this.deps.readInboxRecords(this.paths, undefined);
    const matched = records.find((record) => record.id === id);
    if (!matched) {
      return null;
    }

    const detail = await readArticleDetailOrNull(matched, this.deps.readArticleDocument);
    if (!detail) {
      return null;
    }
    const { summary: _previousSummary, note: _previousNote, ...articleBase } = detail.article;
    const nextSummary = input.summary === undefined ? detail.article.summary : input.summary.trim();
    const nextNote = input.note === undefined ? detail.article.note : input.note;
    const nextDeletedAt = input.deletedAt === undefined ? detail.article.deletedAt : input.deletedAt;
    const nextArticle: SignalArticle = SignalArticleSchema.parse({
      ...articleBase,
      ...(input.status ? { status: input.status } : {}),
      ...(input.tags ? { tags: Array.from(input.tags) } : {}),
      ...(nextSummary ? { summary: nextSummary } : {}),
      ...(nextNote ? { note: nextNote } : {}),
      ...(nextDeletedAt ? { deletedAt: nextDeletedAt } : {}),
    }) as SignalArticle;

    await writeArticleDocument({
      filePath: detail.article.filePath,
      frontmatter: toUpdatedFrontmatter(detail.frontmatter, nextArticle),
      content: detail.content,
    });

    const enriched = await enrichWithStudyMeta(nextArticle, this.studyMeta);
    return {
      ...enriched,
      content: detail.content,
    };
  }

  async getStats(now: Date = new Date()): Promise<SignalArticleStats> {
    const records = await this.deps.readInboxRecords(this.paths, undefined);
    const details = await readArticleDetailsSafely(records, this.deps.readArticleDocument);
    return computeSignalArticleStats(
      details.filter((detail) => !detail.article.deletedAt).map((detail) => detail.article),
      now,
    );
  }
}
