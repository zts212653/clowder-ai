import type { SignalSource } from '@cat-cafe/shared';
import type { FetchError, Fetcher, FetchResult, RawArticle } from './types.js';

interface JsonResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export interface ApiFetchOptions {
  readonly headers?: Record<string, string> | undefined;
  readonly signal?: AbortSignal | undefined;
}

type FetchLike = (url: string, options?: ApiFetchOptions) => Promise<JsonResponseLike>;
type GitHubPatResolver = () => string | undefined;

export interface ApiFetcherOptions {
  readonly getGitHubPat?: GitHubPatResolver | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function nowIso(): string {
  return new Date().toISOString();
}

function unsupportedSourceError(source: SignalSource): FetchError {
  return {
    code: 'UNSUPPORTED_SOURCE',
    message: `source "${source.id}" is not an API source`,
    sourceId: source.id,
  };
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
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function collectArticleCandidates(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;

  const record = asRecord(payload);
  if (!record) return [];

  for (const key of ['items', 'data', 'results', 'hits', 'articles']) {
    const maybeArray = record[key];
    if (Array.isArray(maybeArray)) {
      return maybeArray;
    }
  }

  return [record];
}

function toRawArticle(candidate: unknown, fallbackPublishedAt: string): RawArticle | null {
  const record = asRecord(candidate);
  if (!record) return null;

  const title = pickString(record, ['title', 'name', 'headline']);
  const url = pickString(record, ['url', 'html_url', 'link', 'story_url']);
  if (!title || !url) return null;

  const publishedAt =
    pickString(record, ['publishedAt', 'published_at', 'created_at', 'updated_at', 'date']) ?? fallbackPublishedAt;
  const summary = pickString(record, ['summary', 'description', 'abstract', 'story_text']);
  const content = pickString(record, ['content', 'body', 'text']);

  return {
    url,
    title,
    publishedAt,
    ...(summary ? { summary } : {}),
    ...(content ? { content } : {}),
  };
}

function parseApiPayload(payload: unknown, fallbackPublishedAt: string): readonly RawArticle[] {
  return collectArticleCandidates(payload)
    .map((candidate) => toRawArticle(candidate, fallbackPublishedAt))
    .filter((item): item is RawArticle => item !== null);
}

function extractErrorDetail(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  return pickString(record, ['message', 'error', 'detail', 'reason']);
}

async function toHttpErrorMessage(response: JsonResponseLike): Promise<string> {
  const baseMessage = `HTTP ${response.status} ${response.statusText}`;

  try {
    const payload = await response.json();
    const detail = extractErrorDetail(payload);
    return detail ? `${baseMessage}: ${detail}` : baseMessage;
  } catch {
    return baseMessage;
  }
}

function isGitHubApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'api.github.com';
  } catch {
    return false;
  }
}

function cleanToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveHeaders(source: SignalSource, getGitHubPat: GitHubPatResolver): Record<string, string> | undefined {
  const base = source.fetch.headers ?? {};
  if (!isGitHubApiUrl(source.url)) return source.fetch.headers;

  const pat = cleanToken(getGitHubPat());
  if (!pat) return source.fetch.headers;

  return { ...base, Authorization: `Bearer ${pat}` };
}

export class ApiFetcher implements Fetcher {
  private readonly fetchImpl: FetchLike;
  private readonly getGitHubPat: GitHubPatResolver;

  constructor(fetchImpl?: FetchLike, options: ApiFetcherOptions = {}) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.getGitHubPat = options.getGitHubPat ?? (() => process.env.GITHUB_MCP_PAT);
  }

  canHandle(source: SignalSource): boolean {
    return source.fetch.method === 'api';
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
        headers: resolveHeaders(source, this.getGitHubPat),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await toHttpErrorMessage(response));
      }

      const payload = await response.json();
      const articles = parseApiPayload(payload, fetchedAt);

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
            code: 'API_FETCH_FAILED',
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
