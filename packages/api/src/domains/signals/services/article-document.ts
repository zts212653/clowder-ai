import { readFile, writeFile } from 'node:fs/promises';
import type { SignalArticle } from '@cat-cafe/shared';
import { SignalArticleSchema, SignalArticleStatusSchema } from '@cat-cafe/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { InboxRecord } from './inbox-records.js';

export interface SignalArticleDetail extends SignalArticle {
  readonly content: string;
  /** The original page's full text has been fetched (enrich ran); before that the content is the feed summary. */
  readonly enriched?: boolean;
}

export interface ParsedArticleDocument {
  readonly article: SignalArticle;
  readonly content: string;
  readonly frontmatter: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return undefined;
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const results: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (normalized.length > 0) {
      results.push(normalized);
    }
  }

  return results;
}

function parseFrontmatter(rawMarkdown: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
} {
  if (!rawMarkdown.startsWith('---\n')) {
    return {
      frontmatter: {},
      content: rawMarkdown,
    };
  }

  const marker = '\n---\n';
  const endIndex = rawMarkdown.indexOf(marker, 4);
  if (endIndex === -1) {
    return {
      frontmatter: {},
      content: rawMarkdown,
    };
  }

  const yamlText = rawMarkdown.slice(4, endIndex);
  const parsed = parseYaml(yamlText) as unknown;

  return {
    frontmatter: asRecord(parsed) ?? {},
    content: rawMarkdown.slice(endIndex + marker.length),
  };
}

function toSignalArticle(record: InboxRecord, frontmatter: Record<string, unknown>): SignalArticle {
  const statusCandidate = pickString(frontmatter, ['status']) ?? 'inbox';
  const statusResult = SignalArticleStatusSchema.safeParse(statusCandidate);
  const status = statusResult.success ? statusResult.data : 'inbox';
  const summary = pickString(frontmatter, ['summary']);

  const note = pickString(frontmatter, ['note']);
  const deletedAt = pickString(frontmatter, ['deletedAt']);

  return SignalArticleSchema.parse({
    id: pickString(frontmatter, ['id']) ?? record.id,
    title: pickString(frontmatter, ['title']) ?? record.title,
    url: pickString(frontmatter, ['url']) ?? record.url,
    source: pickString(frontmatter, ['source']) ?? record.source,
    tier: typeof frontmatter.tier === 'number' ? frontmatter.tier : record.tier,
    publishedAt: pickString(frontmatter, ['publishedAt']) ?? record.fetchedAt,
    fetchedAt: pickString(frontmatter, ['fetchedAt']) ?? record.fetchedAt,
    status,
    tags: toStringArray(frontmatter.tags),
    ...(summary ? { summary } : {}),
    ...(note ? { note } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    filePath: record.filePath,
  }) as SignalArticle;
}

export async function readArticleDocument(record: InboxRecord): Promise<ParsedArticleDocument> {
  const raw = await readFile(record.filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  const article = toSignalArticle(record, parsed.frontmatter);

  return {
    article,
    content: parsed.content.trim(),
    frontmatter: parsed.frontmatter,
  };
}

export function toUpdatedFrontmatter(
  previousFrontmatter: Record<string, unknown>,
  article: SignalArticle,
): Record<string, unknown> {
  const { summary: _prevSummary, note: _prevNote, deletedAt: _prevDeleted, ...base } = previousFrontmatter;
  return {
    ...base,
    id: article.id,
    title: article.title,
    url: article.url,
    source: article.source,
    tier: article.tier,
    publishedAt: article.publishedAt,
    fetchedAt: article.fetchedAt,
    status: article.status,
    tags: article.tags,
    ...(article.summary ? { summary: article.summary } : {}),
    ...(article.note ? { note: article.note } : {}),
    ...(article.deletedAt ? { deletedAt: article.deletedAt } : {}),
  };
}

export async function writeArticleDocument(options: {
  readonly filePath: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
}): Promise<void> {
  const raw = `---\n${stringifyYaml(options.frontmatter)}---\n${options.content.startsWith('\n') ? options.content : `\n${options.content}`}`;
  await writeFile(options.filePath, raw, 'utf-8');
}
