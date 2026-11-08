/** Candidate orchestration shared by document, message, graph and Matter adapters. */
export const KNOWLEDGE_DISCOVERY_VERSION = 'knowledge-discovery-v1';

export interface DiscoveryReadRequest {
  query: string;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface DiscoveryBatch<Candidate> {
  candidates: Candidate[];
  nextCursor?: string;
  truncated?: boolean;
}

/** Source owners keep native indexes, permissions, revisions and exact readers. */
export interface KnowledgeDiscoverySource<Candidate, Item> {
  id: string;
  read(request: DiscoveryReadRequest): Promise<DiscoveryBatch<Candidate>>;
  project(candidate: Candidate): Promise<Item | null>;
  projectWave?(candidates: Candidate[]): Promise<Array<Item | null>>;
  /** Mixed-source consumers recheck native authority after all candidate work has finished. */
  revalidate?(item: Item): Promise<Item | null>;
  key(item: Item): string;
  /** Same canonical identity, when available before an expensive owner read. */
  candidateKey?(candidate: Candidate): string;
  eligible?(candidate: Candidate): boolean;
  tolerateError?: boolean;
  beforeWave?(read: () => Promise<Array<Item | null>>): Promise<Array<Item | null> | undefined>;
  onCandidates?(count: number): void;
  onAccepted?(): void;
}

export interface KnowledgeDiscoveryOptions<Candidate, Item> {
  sources: readonly KnowledgeDiscoverySource<Candidate, Item>[];
  limit: number;
  /** Per-source candidate ceiling; a source's native ceiling may be lower. */
  candidateBudget?: number;
  waveSize?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  check?(): void;
  compare?: (a: Item, b: Item) => number;
  merge?: 'rank' | 'source_order';
}

export interface DiscoverySourceResult<Item> {
  sourceId: string;
  items: Item[];
  inspected: number;
  stopReason: 'exhausted' | 'limit' | 'candidate_budget' | 'source_budget' | 'work_cutoff' | 'error';
  nextCursor?: string;
}

export interface KnowledgeDiscoveryResult<Item> {
  version: typeof KNOWLEDGE_DISCOVERY_VERSION;
  items: Item[];
  sources: DiscoverySourceResult<Item>[];
}

type OwnedDiscoveryOptions<Candidate, Item> = KnowledgeDiscoveryOptions<Candidate, Item> & {
  cancel(reason: unknown): void;
};

export function checkDiscoveryLifetime(options: { signal?: AbortSignal; deadlineAt?: number; check?(): void }): void {
  options.signal?.throwIfAborted();
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
    throw new DOMException('Knowledge discovery deadline exceeded', 'TimeoutError');
  options.check?.();
}

async function withinDiscoveryLifetime<T>(
  read: () => Promise<T>,
  options: { signal?: AbortSignal; deadlineAt?: number; check?(): void; cancel(reason: unknown): void },
): Promise<T> {
  checkDiscoveryLifetime(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(options.signal?.reason ?? new DOMException('Discovery canceled', 'AbortError'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.deadlineAt !== undefined)
        timer = setTimeout(
          () => {
            const reason = new DOMException('Knowledge discovery deadline exceeded', 'TimeoutError');
            options.cancel(reason);
            reject(reason);
          },
          Math.max(0, options.deadlineAt - Date.now()),
        );
      Promise.resolve().then(read).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}

async function discoverSource<Candidate, Item>(
  query: string,
  source: KnowledgeDiscoverySource<Candidate, Item>,
  options: OwnedDiscoveryOptions<Candidate, Item>,
): Promise<DiscoverySourceResult<Item>> {
  const result: DiscoverySourceResult<Item> = { sourceId: source.id, items: [], inspected: 0, stopReason: 'exhausted' };
  const seen = new Set<string>();
  const budget = options.candidateBudget ?? 1000;
  let cursor: string | undefined;
  try {
    while (result.items.length < options.limit && result.inspected < budget) {
      checkDiscoveryLifetime(options);
      const batch = await withinDiscoveryLifetime(
        () =>
          source.read({
            query,
            cursor,
            limit: Math.min(Math.max(options.limit, 20), budget - result.inspected),
            signal: options.signal,
            deadlineAt: options.deadlineAt,
          }),
        options,
      );
      checkDiscoveryLifetime(options);
      source.onCandidates?.(batch.candidates.length);
      result.nextCursor = batch.nextCursor;
      for (let offset = 0; offset < batch.candidates.length && result.inspected < budget; ) {
        checkDiscoveryLifetime(options);
        const width = Math.min(options.waveSize ?? 8, options.limit - result.items.length, budget - result.inspected);
        if (width <= 0) break;
        const wave = batch.candidates.slice(offset, offset + width);
        const selected = wave.filter(
          (candidate) =>
            (!source.eligible || source.eligible(candidate)) &&
            (!source.candidateKey || !seen.has(source.candidateKey(candidate))),
        );
        const read = () =>
          source.projectWave
            ? source.projectWave(selected)
            : Promise.all(selected.map((candidate) => source.project(candidate)));
        const projected = await withinDiscoveryLifetime(
          () => (source.beforeWave ? source.beforeWave(read) : read()),
          options,
        );
        checkDiscoveryLifetime(options);
        if (!projected) {
          result.stopReason = 'work_cutoff';
          return result;
        }
        offset += wave.length;
        result.inspected += wave.length;
        for (const item of projected) {
          if (item === null) continue;
          const key = source.key(item);
          if (seen.has(key)) continue;
          seen.add(key);
          result.items.push(item);
          source.onAccepted?.();
        }
        if (result.items.length >= options.limit) {
          result.stopReason = 'limit';
          return result;
        }
      }
      if (!batch.nextCursor) {
        if (result.inspected >= budget) result.stopReason = 'candidate_budget';
        else if (batch.truncated) result.stopReason = 'source_budget';
        return result;
      }
      if (batch.nextCursor === cursor) throw new Error(`Discovery source ${source.id} did not advance its cursor`);
      cursor = batch.nextCursor;
    }
    result.stopReason = result.inspected >= budget ? 'candidate_budget' : 'limit';
    return result;
  } catch (error) {
    checkDiscoveryLifetime(options);
    if (!source.tolerateError) throw error;
    return { sourceId: source.id, items: [], inspected: result.inspected, stopReason: 'error' };
  }
}

export async function discoverKnowledge<Candidate, Item>(
  query: string,
  options: KnowledgeDiscoveryOptions<Candidate, Item>,
): Promise<KnowledgeDiscoveryResult<Item>> {
  const controller = new AbortController();
  const inheritAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', inheritAbort, { once: true });
  if (options.signal?.aborted) inheritAbort();
  try {
    return await discoverOwned(query, {
      ...options,
      signal: controller.signal,
      deadlineAt: options.deadlineAt ?? Date.now() + 15_000,
      cancel: (reason) => controller.abort(reason),
    });
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    controller.abort(new DOMException('Knowledge discovery finished', 'AbortError'));
    options.signal?.removeEventListener('abort', inheritAbort);
  }
}

async function discoverOwned<Candidate, Item>(
  query: string,
  options: OwnedDiscoveryOptions<Candidate, Item>,
): Promise<KnowledgeDiscoveryResult<Item>> {
  checkDiscoveryLifetime(options);
  const sources: DiscoverySourceResult<Item>[] = [];
  for (let offset = 0; offset < options.sources.length; offset += 4) {
    checkDiscoveryLifetime(options);
    sources.push(
      ...(await Promise.all(
        options.sources.slice(offset, offset + 4).map((source) => discoverSource(query, source, options)),
      )),
    );
  }
  checkDiscoveryLifetime(options);
  for (let index = 0; index < sources.length; index++) {
    const adapter = options.sources[index]!;
    const result = sources[index]!;
    if (!adapter.revalidate) continue;
    const current: Item[] = [];
    let sourceFailed = false;
    for (const item of result.items) {
      checkDiscoveryLifetime(options);
      const fresh = await withinDiscoveryLifetime(async () => {
        try {
          return await adapter.revalidate!(item);
        } catch (error) {
          checkDiscoveryLifetime(options);
          if (!adapter.tolerateError) throw error;
          sourceFailed = true;
          return null;
        }
      }, options);
      checkDiscoveryLifetime(options);
      if (sourceFailed) {
        result.stopReason = 'error';
        current.length = 0;
        break;
      }
      if (fresh !== null && adapter.key(fresh) === adapter.key(item)) current.push(fresh);
    }
    result.items = current;
  }
  const ranked = new Map<string, { item: Item; score: number }>();
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = options.sources[sourceIndex]!;
    for (const [rank, item] of sources[sourceIndex]!.items.entries()) {
      const key = source.key(item);
      const existing = ranked.get(key);
      if (existing) existing.score += 1 / (60 + rank);
      else ranked.set(key, { item, score: 1 / (60 + rank) });
    }
  }
  const items = [...ranked.values()]
    .sort((a, b) =>
      options.compare ? options.compare(a.item, b.item) : options.merge === 'source_order' ? 0 : b.score - a.score,
    )
    .slice(0, options.limit)
    .map(({ item }) => item);
  return { version: KNOWLEDGE_DISCOVERY_VERSION, items, sources };
}
