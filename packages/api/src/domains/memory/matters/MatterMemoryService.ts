import type {
  CatId,
  MatterCatalog,
  MatterEntryView,
  MatterPage,
  MatterReadDetails,
  MatterSourceReference,
  MatterWriteInput,
  MatterWriteRef,
  MemoryMatter,
  RecallScopeV1,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MemoryCueEpisodeStore } from '../cue/MemoryCueEpisodeStore.js';
import { MatterMemoryStore, type StoredMatter } from './MatterMemoryStore.js';
import { canReadMatterGuards, captureMatterAccessGuard } from './matter-access.js';
import type { MatterCatalogContext } from './matter-catalog-cursor.js';
import { MatterDiscoveryIndex } from './matter-discovery-index.js';
import { bindMatterDiscoverySource, discoverMatterCatalog } from './matter-discovery-source.js';
import { matterReadEvidenceEntries } from './matter-read-evidence.js';
import {
  captureMatterInvocation,
  captureMatterPointer,
  matterEntryReadRef,
  projectMatterPointer,
} from './matter-reference.js';
import {
  captureMatterSource,
  findMatterSourceSelection,
  type MatterActor,
  MatterMemoryError,
  type MatterSourceReaders,
  matterDigest,
  projectMatterSource,
} from './matter-source.js';
import { normalizeMatterWriteContent } from './matter-write-content.js';
import { revalidateMatterWriteSnapshot } from './matter-write-snapshot.js';

const sourceReadConcurrency = 4;

export interface MatterMemoryDeps extends MatterSourceReaders {
  db: Database.Database;
  runWrite: <T>(operation: () => T | Promise<T>) => Promise<T>;
  onChanged?: (ownerUserId: string) => void;
}
function publicMatter({
  ownerUserId: _owner,
  accessGuards: _guards,
  descriptionEntryId: _seed,
  ...matter
}: StoredMatter): MemoryMatter {
  return matter;
}
const cursorSchema = z.object({ scope: z.string(), after: z.string().max(200) }).strict();
function readCursor(cursor: string | undefined, scope: string): string {
  if (!cursor) return '';
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.scope !== scope) throw new Error('scope');
    return parsed.after;
  } catch {
    throw new MatterMemoryError('invalid_cursor');
  }
}
function nextCursor(scope: string, after: string): string {
  return Buffer.from(JSON.stringify({ scope, after })).toString('base64url');
}
function actorKey(actor: MatterActor): string {
  return actor.viewer.type === 'user' ? 'owner' : `cat:${actor.viewer.catId}`;
}

/** Owner UI, callback tools and opening directories share this current permission projection. */
export class MatterMemoryService {
  readonly store: MatterMemoryStore;
  private readonly discoveryIndex: MatterDiscoveryIndex;
  constructor(private readonly deps: MatterMemoryDeps) {
    this.store = new MatterMemoryStore(deps.db);
    this.discoveryIndex = new MatterDiscoveryIndex(deps.db);
  }

  selectSource(actor: MatterActor, input: { threadId: string; messageId: string; quote: string }) {
    return findMatterSourceSelection(this.deps, actor, input);
  }

  async writeSnapshot(actor: MatterActor, matterId: string, ref: Pick<MatterWriteRef, 'actorKey' | 'requestId'>) {
    const page = await this.project(actor, matterId);
    if (!page) throw new MatterMemoryError('not_available');
    const snapshot = this.store.writeSnapshot(actor.userId, matterId, ref);
    if (!snapshot) throw new MatterMemoryError('not_available');
    return revalidateMatterWriteSnapshot(snapshot, page);
  }

  async project(actor: MatterActor, matterId: string): Promise<MatterPage | null> {
    const matter = this.store.get(actor.userId, matterId);
    if (!matter) return null;
    if (!(await canReadMatterGuards(this.deps, actor, matter.accessGuards))) return null;
    const entries: MatterEntryView[] = [];
    // Superseded/retired sources may still support title/description. They cannot bypass this gate.
    const storedEntries = this.store.entries(matterId);
    for (let offset = 0; offset < storedEntries.length; offset += sourceReadConcurrency) {
      actor.signal?.throwIfAborted();
      const batch = storedEntries.slice(offset, offset + sourceReadConcurrency);
      const sources = await Promise.allSettled(
        batch.map((entry) =>
          'kind' in entry.source
            ? projectMatterPointer(this.deps, actor, entry.source)
            : projectMatterSource(this.deps, actor, entry.source),
        ),
      );
      actor.signal?.throwIfAborted();
      for (const [index, entry] of batch.entries()) {
        // Preserve serial precedence: an earlier hidden source still hides only its page,
        // even if a speculative read later in this batch rejected.
        const result = sources[index]!;
        if (result.status === 'rejected') throw result.reason;
        const source = result.value;
        if (!source) return null;
        entries.push({
          ...entry,
          ...source,
          ...(entry.summary ? { entryRevision: matterDigest(entry) } : {}),
          attribution:
            !('kind' in entry.source) && entry.source.segment === 'quote_text' ? 'quoted_in_message' : 'author',
        });
      }
    }
    const sourcesChanged = entries.some((entry) => entry.status === 'active' && entry.sourceStatus === 'changed');
    return {
      matter: publicMatter(matter),
      entries,
      ...(sourcesChanged ? { summaryStatus: 'sources_changed' as const } : {}),
    };
  }

  discoverySource(actor: MatterActor, options: MatterCatalogContext & { signal?: AbortSignal } = {}) {
    return bindMatterDiscoverySource(this.discoveryIndex, (reader, id) => this.project(reader, id), actor, options)
      .source;
  }

  async catalog(
    actor: MatterActor,
    options: MatterCatalogContext & { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<MatterCatalog> {
    const catalog = await discoverMatterCatalog(
      this.discoveryIndex,
      (reader, id) => this.project(reader, id),
      actor,
      options,
    );
    return {
      ...catalog,
      items: catalog.items.map((item) =>
        'unavailable' in item
          ? item
          : {
              ...item,
              readRef: { kind: 'matter' as const, matterId: item.matterId, expectedRevision: item.revision },
            },
      ),
    };
  }

  async read(
    actor: MatterActor,
    matterId: string,
    options: { cursor?: string; limit?: number; history?: boolean; expectedRevision?: number } = {},
  ): Promise<MatterPage> {
    const page = await this.project(actor, matterId);
    if (!page || (page.matter.status !== 'active' && actor.viewer.type !== 'user'))
      throw new MatterMemoryError('not_available');
    if (options.expectedRevision !== undefined && options.expectedRevision !== page.matter.revision)
      throw new MatterMemoryError('stale_revision');
    const scope = matterDigest([
      actor.userId,
      actorKey(actor),
      actor.publicReply === true,
      matterId,
      page.matter.revision,
      options.history === true,
    ]);
    const after = readCursor(options.cursor, scope);
    const limit = Math.max(1, Math.min(options.limit ?? 12, 30));
    const entries = page.entries.filter(
      (entry) => entry.entryId > after && (options.history || entry.status === 'active'),
    );
    return {
      matter: page.matter,
      ...(page.summaryStatus ? { summaryStatus: page.summaryStatus } : {}),
      entries: entries.slice(0, limit).map((entry) => {
        const readRef = matterEntryReadRef(entry.source);
        return { ...entry, ...(readRef ? { readRef } : {}) };
      }),
      ...(entries.length > limit ? { nextCursor: nextCursor(scope, entries[limit - 1]!.entryId) } : {}),
    };
  }

  async readForInvocation(
    scope: RecallScopeV1,
    catId: CatId,
    matterId: string,
    options: { cursor?: string; limit?: number; history?: boolean; expectedRevision?: number } = {},
  ) {
    return this.deps.runWrite(async () => {
      const page = await this.read({ userId: scope.ownerUserId, viewer: { type: 'cat', catId } }, matterId, options);
      const entries = matterReadEvidenceEntries(page.entries);
      // Serialize before recording success; a directory, changed-only page or owner UI is never a cat read.
      JSON.stringify(page);
      if (entries.length)
        new MemoryCueEpisodeStore(this.deps.db).appendMatterRead({
          scope,
          consumerCatId: catId,
          details: { matterId, pageRevision: page.matter.revision, entries },
        });
      return page;
    });
  }

  /** Revalidates both present permissions and the exact page/source versions that this cat received. */
  async readReceipt(
    ownerUserId: string,
    consumerCatId: CatId,
    details: MatterReadDetails,
    publicReply = false,
  ): Promise<{ status: 'current'; page: MatterPage } | { status: 'changed' | 'not_available' }> {
    const page = await this.project(
      { userId: ownerUserId, viewer: { type: 'cat', catId: consumerCatId }, publicReply },
      details.matterId,
    );
    if (!page) return { status: 'not_available' };
    if (page.matter.revision !== details.pageRevision || page.matter.status !== 'active' || page.summaryStatus)
      return { status: 'changed' };
    const selected: MatterEntryView[] = [];
    for (const expected of details.entries) {
      const entry = page.entries.find((candidate) => candidate.entryId === expected.entryId);
      if (
        !entry ||
        entry.sourceStatus === 'changed' ||
        ('entryRevision' in expected
          ? entry.entryRevision !== expected.entryRevision
          : 'kind' in entry.source || entry.source.sourceRevision !== expected.sourceRevision)
      )
        return { status: 'changed' };
      selected.push(entry);
    }
    return { status: 'current', page: { matter: page.matter, entries: selected } };
  }

  async write(actor: MatterActor, input: MatterWriteInput) {
    return this.deps.runWrite(async () => {
      if (input.operation === 'forget' && actor.viewer.type !== 'user') throw new MatterMemoryError('not_available');
      const retry = this.store.retry(actor.userId, actorKey(actor), input);
      if (retry?.outcome === 'forgotten') return retry;
      const matterId = input.operation === 'create' ? retry?.matter.matterId : input.matterId;
      const ownerManagement =
        actor.viewer.type === 'user' && (input.operation === 'retire' || input.operation === 'forget');
      const before = matterId && !ownerManagement ? await this.project(actor, matterId) : undefined;
      if (matterId && !(ownerManagement ? this.store.get(actor.userId, matterId) : before)) {
        throw new MatterMemoryError('not_available');
      }
      if (retry) return retry;
      const inputs =
        input.operation === 'create' || input.operation === 'append'
          ? input.sources
          : input.operation === 'correct'
            ? input.source
              ? [input.source]
              : undefined
            : [];
      const content = normalizeMatterWriteContent(input);
      const writingEntry =
        input.operation === 'create' || input.operation === 'append' || input.operation === 'correct';
      if (writingEntry && !content.summary && (!inputs?.length || inputs.some((source) => !('segment' in source))))
        throw new MatterMemoryError('invalid_source', {
          reason: 'summary_required',
          hint: 'Provide summary (your interpretation); a thread/message pointer is optional. Exact quotations remain optional and keep their original selection fields.',
        });
      const sources: MatterSourceReference[] = [];
      if (writingEntry && !inputs) sources.push(await captureMatterInvocation(this.deps, actor));
      for (const source of inputs ?? [])
        sources.push(
          await ('segment' in source
            ? captureMatterSource(this.deps, actor, source)
            : captureMatterPointer(this.deps, actor, source)),
        );
      const writer =
        actor.viewer.type === 'cat'
          ? { kind: 'agent' as const, catId: actor.viewer.catId }
          : { kind: 'user' as const, userId: actor.userId };
      const accessGuard =
        writingEntry || input.operation === 'edit' ? await captureMatterAccessGuard(this.deps, actor) : undefined;
      const result = this.store.write(
        actor.userId,
        actorKey(actor),
        input,
        sources,
        content,
        writer,
        accessGuard,
        before ?? undefined,
      );
      this.deps.onChanged?.(actor.userId);
      return result;
    });
  }
}
