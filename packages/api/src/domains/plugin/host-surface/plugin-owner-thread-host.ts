import type { IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { currentOwnerOperation } from '../carrier/plugin-owner-operation-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { type PluginThreadProjectionDeps, validatePreferredCats } from './plugin-thread-projections.js';

export interface PluginOwnerThread {
  readonly id: string;
  readonly createdBy: string;
  readonly participants: readonly string[];
}

/** Authenticated owner requests and Settings operations; native calls confer no ownership. */
export interface PluginOwnerThreadHost {
  get(threadId: string): Promise<PluginOwnerThread | null>;
  create(input: { readonly title: string }): Promise<PluginOwnerThread>;
  addParticipants(input: { readonly threadId: string; readonly catIds: readonly string[] }): Promise<PluginOwnerThread>;
}

interface Deps {
  readonly pluginInstanceId: string;
  readonly ownerUserId: string | undefined;
  readonly threadStore: IThreadStore | undefined;
  readonly projectPath: string | undefined;
  readonly cats: PluginThreadProjectionDeps['cats'];
  /** Rechecks this activation's inventory identity, lifecycle revision and effective grants. */
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty bounded string without surrounding whitespace`);
  }
  return value;
}

function inputRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = snapshotPluginProtocolData(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an input object');
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError('Unexpected or missing owner thread input fields');
  }
  return value as Record<string, unknown>;
}

function project(thread: Thread): PluginOwnerThread {
  return Object.freeze({
    id: thread.id,
    createdBy: thread.createdBy,
    participants: Object.freeze([...thread.participants]),
  });
}

export function createPluginOwnerThreadHost(deps: Deps): PluginOwnerThreadHost {
  function principal(write: boolean) {
    if (!deps.ownerUserId || !deps.threadStore) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host owner thread services unavailable');
    }
    const request = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    const owner = request ?? currentOwnerOperation(deps.pluginInstanceId);
    if (!owner || owner.userId !== deps.ownerUserId || (write && request && request.operation !== 'write')) {
      refuse('A current authenticated owner request is required for owner threads');
    }
    return {
      store: deps.threadStore,
      userId: owner.userId,
      async current() {
        await owner.assertCurrent();
        await deps.assertCurrent([write ? 'thread.write' : 'thread.listMetadata']);
        await owner.assertCurrent();
      },
    };
  }

  async function read(id: string, caller: ReturnType<typeof principal>): Promise<Thread | null> {
    await caller.current();
    const thread = await caller.store.get(id);
    await caller.current();
    return thread && !thread.deletedAt && thread.createdBy === caller.userId ? thread : null;
  }

  async function requireThread(id: string, caller: ReturnType<typeof principal>): Promise<Thread> {
    const thread = await read(id, caller);
    if (!thread) refuse('Owner thread is unavailable');
    return thread;
  }

  return Object.freeze({
    async get(threadId: string) {
      const id = bounded(threadId, 'threadId', 500);
      const thread = await read(id, principal(false));
      return thread ? project(thread) : null;
    },
    async create(input: { readonly title: string }) {
      const value = inputRecord(input, ['title']);
      const title = bounded(value.title, 'title', 200);
      const caller = principal(true);
      await caller.current();
      const created = await caller.store.create(caller.userId, title, deps.projectPath);
      await caller.current();
      return project(await requireThread(created.id, caller));
    },
    async addParticipants(input: { readonly threadId: string; readonly catIds: readonly string[] }) {
      const value = inputRecord(input, ['threadId', 'catIds']);
      const id = bounded(value.threadId, 'threadId', 500);
      const ids = validatePreferredCats(value.catIds, deps.cats);
      const caller = principal(true);
      const thread = await requireThread(id, caller);
      const missing = ids.filter((catId) => !thread.participants.includes(catId));
      if (missing.length) {
        await caller.current();
        if (thread.deletedAt || thread.createdBy !== caller.userId) refuse('Owner thread is unavailable');
        await caller.store.addParticipants(id, missing);
        await caller.current();
      }
      return project(await requireThread(id, caller));
    },
  });
}
