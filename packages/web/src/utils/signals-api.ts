import type { SignalArticle, SignalArticleStatus, SignalSource, SignalTier, StudyMeta } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export interface SignalArticleDetail extends SignalArticle {
  readonly content: string;
}

export interface SignalArticleStats {
  readonly todayCount: number;
  readonly weekCount: number;
  readonly unreadCount: number;
  readonly byTier: Record<string, number>;
  readonly bySource: Record<string, number>;
}

export interface SignalsSearchOptions {
  readonly limit?: number | undefined;
  readonly status?: SignalArticleStatus | undefined;
  readonly source?: string | undefined;
  readonly tier?: SignalTier | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
}

export interface SignalsInboxOptions {
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly source?: string | undefined;
  readonly tier?: SignalTier | undefined;
  readonly status?: 'all' | 'inbox' | 'read' | 'starred' | 'archived' | undefined;
}

export interface SignalArticleUpdateInput {
  readonly status?: SignalArticleStatus | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly note?: string | undefined;
  readonly deletedAt?: string | undefined;
}

function appendIfPresent(params: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value === undefined || value === '') {
    return;
  }
  params.set(key, String(value));
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    appendIfPresent(params, key, value);
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return payload.error;
    }
    if (typeof payload.detail === 'string' && payload.detail.trim().length > 0) {
      return payload.detail;
    }
  } catch {
    // Ignore JSON parse errors and fallback to generic message.
  }
  return `Server error: ${response.status}`;
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(await readApiError(response));
}

export async function fetchSignalsInbox(options: SignalsInboxOptions = {}): Promise<readonly SignalArticle[]> {
  const response = await apiFetch(
    withQuery('/api/signals/inbox', {
      date: options.date,
      limit: options.limit ?? 20,
      source: options.source,
      tier: options.tier,
      status: options.status,
    }),
  );
  await requireOk(response);
  const data = (await response.json()) as { items: readonly SignalArticle[] };
  return data.items;
}

export async function searchSignals(
  query: string,
  options: SignalsSearchOptions = {},
): Promise<{ readonly total: number; readonly items: readonly SignalArticle[] }> {
  const response = await apiFetch(
    withQuery('/api/signals/search', {
      q: query,
      limit: options.limit ?? 20,
      status: options.status,
      source: options.source,
      tier: options.tier,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
    }),
  );
  await requireOk(response);
  return (await response.json()) as { readonly total: number; readonly items: readonly SignalArticle[] };
}

export async function fetchSignalArticle(articleId: string): Promise<SignalArticleDetail> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}`);
  await requireOk(response);
  const data = (await response.json()) as { article: SignalArticleDetail };
  return data.article;
}

export async function updateSignalArticle(
  articleId: string,
  input: SignalArticleUpdateInput,
): Promise<SignalArticleDetail> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await requireOk(response);
  const data = (await response.json()) as { article: SignalArticleDetail };
  return data.article;
}

export async function fetchSignalSources(): Promise<readonly SignalSource[]> {
  const response = await apiFetch('/api/signals/sources');
  await requireOk(response);
  const data = (await response.json()) as { sources: readonly SignalSource[] };
  return data.sources;
}

export async function updateSignalSource(sourceId: string, enabled: boolean): Promise<SignalSource> {
  const response = await apiFetch(`/api/signals/sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  await requireOk(response);
  const data = (await response.json()) as { source: SignalSource };
  return data.source;
}

export interface FetchSourceResult {
  readonly summary: {
    readonly fetchedArticles: number;
    readonly newArticles: number;
    readonly storedArticles: number;
    readonly duplicateArticles: number;
    readonly errors: readonly { readonly source: string; readonly message: string }[];
  };
}

export async function triggerSourceFetch(sourceId: string): Promise<FetchSourceResult> {
  const response = await apiFetch(`/api/signals/sources/${encodeURIComponent(sourceId)}/fetch`, {
    method: 'POST',
  });
  await requireOk(response);
  return (await response.json()) as FetchSourceResult;
}

export async function fetchSignalStats(): Promise<SignalArticleStats> {
  const response = await apiFetch('/api/signals/stats');
  await requireOk(response);
  return (await response.json()) as SignalArticleStats;
}

// --- F091: Study Mode API extensions ---

export async function deleteSignalArticle(articleId: string): Promise<void> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}`, {
    method: 'DELETE',
  });
  await requireOk(response);
}

export async function batchSignalArticles(
  ids: readonly string[],
  action: 'update' | 'delete',
  fields?: Omit<SignalArticleUpdateInput, 'deletedAt'>,
): Promise<{ affected: number }> {
  const response = await apiFetch('/api/signals/articles/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action, fields }),
  });
  await requireOk(response);
  return (await response.json()) as { affected: number };
}

export async function fetchStudyMeta(articleId: string): Promise<StudyMeta> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}/study`);
  await requireOk(response);
  const data = (await response.json()) as { meta: StudyMeta };
  return data.meta;
}

export async function linkSignalThread(articleId: string, threadId: string): Promise<StudyMeta> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId }),
  });
  await requireOk(response);
  const data = (await response.json()) as { meta: StudyMeta };
  return data.meta;
}

export async function unlinkSignalThread(articleId: string, threadId: string): Promise<StudyMeta> {
  const response = await apiFetch(
    `/api/signals/articles/${encodeURIComponent(articleId)}/threads/${encodeURIComponent(threadId)}`,
    { method: 'DELETE' },
  );
  await requireOk(response);
  const data = (await response.json()) as { meta: StudyMeta };
  return data.meta;
}

// --- F091 Phase 4: Collection API ---

export interface StudyCollection {
  readonly id: string;
  readonly name: string;
  readonly articleIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function fetchCollections(): Promise<readonly StudyCollection[]> {
  const response = await apiFetch('/api/signals/collections');
  await requireOk(response);
  const data = (await response.json()) as { collections: readonly StudyCollection[] };
  return data.collections;
}

export async function createCollection(name: string, articleIds?: readonly string[]): Promise<StudyCollection> {
  const response = await apiFetch('/api/signals/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, articleIds }),
  });
  await requireOk(response);
  const data = (await response.json()) as { collection: StudyCollection };
  return data.collection;
}

export async function updateCollection(
  id: string,
  patch: { name?: string; articleIds?: readonly string[] },
): Promise<StudyCollection> {
  const response = await apiFetch(`/api/signals/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireOk(response);
  const data = (await response.json()) as { collection: StudyCollection };
  return data.collection;
}

export async function deleteCollection(id: string): Promise<void> {
  const response = await apiFetch(`/api/signals/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await requireOk(response);
}

// --- F091 Phase 4: Podcast API ---

export interface PodcastSegment {
  readonly speaker: string;
  readonly text: string;
  readonly durationEstimate: number;
  readonly audioUrl?: string;
}

export interface PodcastScript {
  readonly mode: string;
  readonly segments: readonly PodcastSegment[];
  readonly totalDuration: number;
}

export async function fetchPodcastScript(
  articleId: string,
  artifactId: string,
): Promise<{ artifact: import('@cat-cafe/shared').StudyArtifact; script: PodcastScript }> {
  const response = await apiFetch(
    `/api/signals/articles/${encodeURIComponent(articleId)}/podcast/${encodeURIComponent(artifactId)}`,
  );
  await requireOk(response);
  return (await response.json()) as { artifact: import('@cat-cafe/shared').StudyArtifact; script: PodcastScript };
}

export async function generatePodcast(
  articleId: string,
  mode: 'essence' | 'deep' = 'essence',
): Promise<{ artifact: import('@cat-cafe/shared').StudyArtifact }> {
  const response = await apiFetch(`/api/signals/articles/${encodeURIComponent(articleId)}/podcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  await requireOk(response);
  return (await response.json()) as { artifact: import('@cat-cafe/shared').StudyArtifact };
}

// --- F091 Phase 4: Timeline API ---

export interface TimelineEntry {
  readonly articleId: string;
  readonly articleTitle: string;
  readonly source: string;
  readonly lastStudiedAt: string;
  readonly artifacts: readonly { id: string; kind: string; state: string; createdAt: string }[];
  readonly threads: readonly { threadId: string; linkedAt: string }[];
}

export async function fetchStudyTimeline(days?: number): Promise<{ entries: readonly TimelineEntry[]; days: number }> {
  const url = days ? `/api/signals/timeline?days=${days}` : '/api/signals/timeline';
  const response = await apiFetch(url);
  await requireOk(response);
  return (await response.json()) as { entries: readonly TimelineEntry[]; days: number };
}
