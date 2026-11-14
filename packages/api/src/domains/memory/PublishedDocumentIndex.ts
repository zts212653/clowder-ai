import { createHash } from 'node:crypto';
import type { PublishedDocumentSnapshot, PublishedDocumentSource } from './PublishedDocumentSource.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

const CHECKPOINT_KEY = 'published_document_checkpoint_v1';
export interface PublishedIndexStatus {
  state: 'pending' | 'up_to_date' | 'degraded';
  publicationRef?: 'origin/main' | 'HEAD';
  observedVersion?: string;
  indexedVersion?: string;
  pendingPaths?: number;
  lastSuccessAt?: string;
  error?: string;
}
interface Checkpoint {
  root: string;
  revision: string;
  files: Array<[string, string]>;
  at: string;
}

/** Derived bookkeeping only. IndexBuilder owns every mutation and the only mutation queue. */
export class PublishedDocumentIndex {
  private status: PublishedIndexStatus = { state: 'pending' };
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private readonly snapshotGenerations = new WeakMap<PublishedDocumentSnapshot, number>();

  constructor(
    readonly source: PublishedDocumentSource,
    private readonly store: SqliteEvidenceStore,
  ) {
    const previous = this.checkpoint();
    if (previous) this.status = { state: 'pending', indexedVersion: previous.revision, lastSuccessAt: previous.at };
  }

  getStatus(): PublishedIndexStatus {
    return { ...this.status };
  }
  markPending(): void {
    this.generation++;
    this.status = { ...this.status, state: 'pending', pendingPaths: undefined };
  }
  failure(error: unknown): void {
    this.status = {
      ...this.status,
      state: 'degraded',
      error: error instanceof Error ? error.name : 'source_update_failed',
    };
  }

  async open(fetchRemote = false): Promise<PublishedDocumentSnapshot> {
    try {
      const generation = this.generation;
      const snapshot = await this.source.snapshot(fetchRemote);
      this.snapshotGenerations.set(snapshot, generation);
      this.status = {
        ...this.status,
        state: 'pending',
        publicationRef: snapshot.publicationRef,
        observedVersion: snapshot.revision,
      };
      return snapshot;
    } catch (error) {
      this.failure(error);
      throw error;
    }
  }

  changes(snapshot: PublishedDocumentSnapshot): string[] {
    const checkpoint = this.checkpoint();
    const prior = new Map(checkpoint?.files ?? []);
    // First adoption also retires stale/untracked docs left by the previous scanner.
    if (!checkpoint) {
      const rows = this.store
        .getDb()
        .prepare(
          "SELECT DISTINCT source_path AS path FROM evidence_docs WHERE kind NOT IN ('thread','session') AND source_path IS NOT NULL",
        )
        .all() as Array<{ path: string }>;
      for (const { path } of rows) prior.set(path, '');
    }
    const changed = [...new Set([...prior.keys(), ...snapshot.files.keys()])].filter(
      (path) => prior.get(path) !== snapshot.files.get(path),
    );
    // A same-version forced rebuild may stop after metadata but before passages.
    // Its earlier checkpoint cannot certify rows that carry an incomplete stamp.
    const incomplete = this.store
      .getDb()
      .prepare('SELECT DISTINCT source_path AS path FROM evidence_docs WHERE source_hash IS NULL')
      .all() as Array<{ path: string | null }>;
    for (const { path } of incomplete) {
      if (path && snapshot.files.has(path) && !changed.includes(path)) changed.push(path);
    }
    // Lifecycle triggers can purge a Taste between snapshot capture and publication.
    // Reconcile missing projections even if a prepared action rolled back to the same revision.
    const indexedTastePaths = new Set(
      (
        this.store
          .getDb()
          .prepare("SELECT source_path AS path FROM evidence_docs WHERE source_path LIKE 'taste/vignettes/%'")
          .all() as Array<{ path: string }>
      ).map((row) => row.path),
    );
    for (const path of snapshot.files.keys()) {
      if (path.startsWith('taste/vignettes/') && !indexedTastePaths.has(path) && !changed.includes(path))
        changed.push(path);
    }
    this.status.pendingPaths = changed.length;
    return changed;
  }

  async commit(snapshot: PublishedDocumentSnapshot): Promise<void> {
    const at = new Date().toISOString();
    const value: Checkpoint = { root: this.source.root, revision: snapshot.revision, files: [...snapshot.files], at };
    const previous = this.checkpoint();
    if (
      previous?.revision !== snapshot.revision ||
      previous.files.length !== snapshot.files.size ||
      previous.files.some(([path, hash]) => snapshot.files.get(path) !== hash)
    )
      await this.store.runExclusive(() =>
        this.store
          .getDb()
          .prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)')
          .run(CHECKPOINT_KEY, JSON.stringify(value)),
      );
    this.status = {
      state: this.snapshotGenerations.get(snapshot) === this.generation ? 'up_to_date' : 'pending',
      publicationRef: snapshot.publicationRef,
      indexedVersion: snapshot.revision,
      observedVersion: snapshot.revision,
      pendingPaths: this.snapshotGenerations.get(snapshot) === this.generation ? 0 : undefined,
      lastSuccessAt: at,
    };
  }

  /** Observe publication independently of queries; one timer, no extra model/process per cat. */
  start(refresh: () => Promise<void>, intervalMs = 30_000): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => {
      if (this.refreshing || this.stopped) return;
      this.refreshing = refresh()
        .catch((error) => this.failure(error))
        .finally(() => {
          this.refreshing = undefined;
        });
    };
    this.timer = setInterval(tick, Math.min(30_000, Math.max(10, intervalMs)));
    this.timer.unref();
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.refreshing;
  }

  async read(
    anchor: string,
    expectedHash: string,
  ): Promise<
    | { status: 'ready'; content: string; revision: string; sourcePath: string }
    | { status: 'source_changed' | 'unavailable' }
  > {
    const item = await this.store.getByAnchor(anchor);
    if (!item?.sourcePath) return { status: 'unavailable' };
    if (item.sourceHash !== expectedHash) return { status: 'source_changed' };
    const snapshot = await this.source.snapshot();
    const scanned = (await snapshot.scan([item.sourcePath])).find((row) => row.item.anchor === anchor);
    if (!scanned) return { status: 'unavailable' };
    const hash = createHash('sha256').update(scanned.rawContent).digest('hex').slice(0, 16);
    // Recheck lifecycle and indexed identity after asynchronous Git reads.
    const current = await this.store.getByAnchor(anchor);
    if (!current) return { status: 'unavailable' };
    if (hash !== expectedHash || current.sourceHash !== expectedHash) return { status: 'source_changed' };
    return { status: 'ready', content: scanned.rawContent, revision: snapshot.revision, sourcePath: item.sourcePath };
  }

  private checkpoint(): Checkpoint | undefined {
    const row = this.store.getDb().prepare('SELECT value FROM embedding_meta WHERE key = ?').get(CHECKPOINT_KEY) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as Checkpoint;
      return value.root === this.source.root &&
        typeof value.revision === 'string' &&
        Array.isArray(value.files) &&
        value.files.every(
          (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((x) => typeof x === 'string'),
        )
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
}
