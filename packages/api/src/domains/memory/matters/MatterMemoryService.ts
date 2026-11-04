import type {
  CatId,
  MatterCatalog,
  MatterEntryView,
  MatterPage,
  MatterReadDetails,
  MatterWriteInput,
  MemoryMatter,
  RecallScopeV1,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MemoryCueEpisodeStore } from '../cue/MemoryCueEpisodeStore.js';
import { MatterMemoryStore, type StoredMatter } from './MatterMemoryStore.js';
import {
  captureMatterSource,
  findMatterSourceSelection,
  type MatterActor,
  MatterMemoryError,
  type MatterSourceReaders,
  matterDigest,
  projectMatterSource,
} from './matter-source.js';

export interface MatterMemoryDeps extends MatterSourceReaders {
  db: Database.Database;
  runWrite: <T>(operation: () => T | Promise<T>) => Promise<T>;
  onChanged?: (ownerUserId: string) => void;
}
function publicMatter({ ownerUserId: _owner, ...matter }: StoredMatter): MemoryMatter {
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
  constructor(private readonly deps: MatterMemoryDeps) {
    this.store = new MatterMemoryStore(deps.db);
  }

  selectSource(actor: MatterActor, input: { threadId: string; messageId: string; quote: string }) {
    return findMatterSourceSelection(this.deps, actor, input);
  }

  async project(actor: MatterActor, matterId: string): Promise<MatterPage | null> {
    const matter = this.store.get(actor.userId, matterId);
    if (!matter) return null;
    const entries: MatterEntryView[] = [];
    // Superseded/retired sources may still support title/description. They cannot bypass this gate.
    for (const entry of this.store.entries(matterId)) {
      const source = await projectMatterSource(this.deps, actor, entry.source);
      if (!source) return null;
      entries.push({
        ...entry,
        ...source,
        attribution: entry.source.segment === 'quote_text' ? 'quoted_in_message' : 'author',
      });
    }
    return { matter: publicMatter(matter), entries };
  }

  async catalog(
    actor: MatterActor,
    options: { query?: string; cursor?: string; limit?: number; management?: boolean; signal?: AbortSignal } = {},
  ): Promise<MatterCatalog> {
    const management = options.management === true && actor.viewer.type === 'user';
    const scope = matterDigest([
      actor.userId,
      actorKey(actor),
      actor.publicReply === true,
      options.query ?? '',
      management,
      'catalog',
    ]);
    const after = readCursor(options.cursor, scope);
    const limit = Math.max(1, Math.min(options.limit ?? 12, 30));
    const items: MatterCatalog['items'] = [];
    const query = options.query?.toLocaleLowerCase();
    for (const matter of this.store.list(actor.userId, after, management)) {
      options.signal?.throwIfAborted();
      const page = await this.project({ ...actor, signal: options.signal }, matter.matterId);
      if (!page) {
        if (!management || query) continue;
        items.push({ matterId: matter.matterId, revision: matter.revision, status: matter.status, unavailable: true });
      } else {
        if (query && !`${page.matter.title}\n${page.matter.description}`.toLocaleLowerCase().includes(query)) continue;
        items.push({ ...page.matter, entryCount: page.entries.filter((entry) => entry.status === 'active').length });
      }
      if (items.length > limit)
        return { items: items.slice(0, limit), nextCursor: nextCursor(scope, items[limit - 1]!.matterId) };
    }
    return { items };
  }

  async read(
    actor: MatterActor,
    matterId: string,
    options: { cursor?: string; limit?: number; history?: boolean } = {},
  ): Promise<MatterPage> {
    const page = await this.project(actor, matterId);
    if (!page || (page.matter.status !== 'active' && actor.viewer.type !== 'user'))
      throw new MatterMemoryError('not_available');
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
      entries: entries.slice(0, limit),
      ...(entries.length > limit ? { nextCursor: nextCursor(scope, entries[limit - 1]!.entryId) } : {}),
    };
  }

  async readForInvocation(
    scope: RecallScopeV1,
    catId: CatId,
    matterId: string,
    options: { cursor?: string; limit?: number; history?: boolean } = {},
  ) {
    return this.deps.runWrite(async () => {
      const page = await this.read({ userId: scope.ownerUserId, viewer: { type: 'cat', catId } }, matterId, options);
      const entries = page.entries
        .filter((entry) => entry.sourceStatus === 'current' && Boolean(entry.quote))
        .map((entry) => ({ entryId: entry.entryId, sourceRevision: entry.source.sourceRevision }));
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
    if (page.matter.revision !== details.pageRevision || page.matter.status !== 'active') return { status: 'changed' };
    const selected: MatterEntryView[] = [];
    for (const expected of details.entries) {
      const entry = page.entries.find((candidate) => candidate.entryId === expected.entryId);
      if (!entry || entry.sourceStatus !== 'current' || entry.source.sourceRevision !== expected.sourceRevision)
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
      if (
        matterId &&
        !(ownerManagement ? this.store.get(actor.userId, matterId) : await this.project(actor, matterId))
      ) {
        throw new MatterMemoryError('not_available');
      }
      if (retry) return retry;
      const inputs =
        input.operation === 'create' || input.operation === 'append'
          ? input.sources
          : input.operation === 'correct'
            ? [input.source]
            : [];
      const sources = [];
      for (const source of inputs) sources.push(await captureMatterSource(this.deps, actor, source));
      const result = this.store.write(actor.userId, actorKey(actor), input, sources);
      this.deps.onChanged?.(actor.userId);
      return result;
    });
  }
}
