import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { hostCapabilityRefusal } from './host-capability-refusal.js';
import {
  boundedLimit,
  type PluginThreadCats,
  type PluginThreadMessage,
  type PluginThreadProjectionDeps,
  type PluginThreadSummary,
  projectionUnavailable,
  projectThread,
  projectThreadCats,
  projectThreadMessages,
  validatePreferredCats,
} from './plugin-thread-projections.js';

export type { PluginThreadCats, PluginThreadMessage, PluginThreadSummary } from './plugin-thread-projections.js';

const MAX_THREAD_KEY_LENGTH = 500;
const MAX_THREAD_ID_LENGTH = 500;
const MAX_THREAD_TITLE_LENGTH = 200;
export const SYSTEM_BINDING_KEY = '__plugin_system_thread__';

export interface PluginThreadBindingSummary {
  readonly key: string;
  readonly threadId: string;
  readonly createdAt: number;
}

export interface PluginThreadListCursor {
  readonly lastActiveAt: number;
  readonly id: string;
}

export interface PluginThreadHost {
  get(threadId: string): Promise<PluginThreadSummary | null>;
  /** Live keyset pagination: pass the last row's coordinates; a short/empty page ends traversal. */
  list(options?: {
    readonly limit?: number;
    readonly before?: PluginThreadListCursor;
  }): Promise<readonly PluginThreadSummary[]>;
  readMessages(
    threadId: string,
    options: { readonly before?: { readonly timestamp: number; readonly id: string }; readonly limit: number },
  ): Promise<readonly PluginThreadMessage[]>;
  getCats(threadId: string): Promise<PluginThreadCats>;
  create(input: { readonly title: string }): Promise<PluginThreadSummary>;
  update(
    threadId: string,
    patch: { readonly title?: string; readonly preferredCats?: readonly string[] },
  ): Promise<PluginThreadSummary>;
  findByKey(key: string): Promise<PluginThreadSummary | null>;
  ensureByKey(key: string, input: { readonly title: string }): Promise<PluginThreadSummary>;
  bind(key: string, threadId: string): Promise<PluginThreadBindingSummary>;
  unbind(key: string): Promise<boolean>;
  listBindings(): Promise<readonly PluginThreadBindingSummary[]>;
  ensureSystemThread(): Promise<PluginThreadSummary>;
}

export interface PluginThreadHostDeps extends PluginThreadProjectionDeps {
  readonly threadDeepLinkUrl: (threadId: string) => string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly projectPath: string;
  readonly effectiveGrants: readonly string[];
  readonly systemThreadTitle: string;
  readonly threadStore: IThreadStore;
  readonly bindingStore: IConnectorThreadBindingStore;
}

export function createUnavailablePluginThreadHost(): PluginThreadHost {
  const unavailable = async (): Promise<never> => {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host thread services are unavailable');
  };
  return {
    get: unavailable,
    list: unavailable,
    readMessages: unavailable,
    getCats: unavailable,
    create: unavailable,
    update: unavailable,
    findByKey: unavailable,
    ensureByKey: unavailable,
    bind: unavailable,
    unbind: unavailable,
    listBindings: unavailable,
    ensureSystemThread: unavailable,
  };
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function bindingKey(value: unknown): string {
  const key = boundedString(value, 'thread key', MAX_THREAD_KEY_LENGTH);
  if (key === SYSTEM_BINDING_KEY) throw new TypeError('thread key is reserved by the Host');
  return key;
}

function title(value: unknown): string {
  return boundedString(value, 'thread title', MAX_THREAD_TITLE_LENGTH);
}

function threadId(value: unknown): string {
  return boundedString(value, 'threadId', MAX_THREAD_ID_LENGTH);
}

function bindingSummary(binding: {
  readonly externalChatId: string;
  readonly threadId: string;
  readonly createdAt: number;
}): PluginThreadBindingSummary {
  return { key: binding.externalChatId, threadId: binding.threadId, createdAt: binding.createdAt };
}

function listCursor(value: PluginThreadListCursor | undefined): PluginThreadListCursor | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'lastActiveAt' && key !== 'id') ||
    !Number.isSafeInteger(value.lastActiveAt) ||
    value.lastActiveAt < 0
  )
    throw new TypeError('before must contain a non-negative activity timestamp and thread id');
  boundedString(value.id, 'before.id', MAX_THREAD_ID_LENGTH);
  return value;
}

// One locale-independent ordering for both sorting and the exclusive cursor boundary.
function compareThreadPosition(a: PluginThreadListCursor, b: PluginThreadListCursor): number {
  return b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Thin, caller-bound projection of the Host's existing thread and binding stores. */
export function createPluginThreadHost(input: PluginThreadHostDeps): PluginThreadHost {
  const summary = (thread: Thread) =>
    projectThread(thread, input.ownerUserId, input.backlogStore, input.threadDeepLinkUrl);
  const ensureTails = new Map<string, Promise<void>>();
  const requireGrant = (capability: 'thread.listMetadata' | 'thread.readContent' | 'thread.write') => {
    if (!input.effectiveGrants.includes(capability)) {
      throw hostCapabilityRefusal(
        new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} lacks ${capability}`),
        capability,
      );
    }
  };

  const readThread = async (id: string): Promise<Thread | null> => {
    const thread = await input.threadStore.get(threadId(id));
    return thread?.deletedAt ? null : thread;
  };
  const hasPluginBinding = async (id: string): Promise<boolean> => {
    const bindings = await input.bindingStore.getByThread(id);
    return bindings.some((binding) => binding.connectorId === input.pluginId && binding.userId === input.ownerUserId);
  };
  const canAccess = async (thread: Thread): Promise<boolean> =>
    thread.createdBy === input.ownerUserId ||
    thread.pluginOwnership?.pluginInstanceId === input.pluginInstanceId ||
    (await hasPluginBinding(thread.id));
  const requireAccessible = async (id: string): Promise<Thread> => {
    const thread = await readThread(id);
    if (!thread) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `thread ${id} does not exist`);
    if (!(await canAccess(thread))) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} cannot access thread ${id}`);
    }
    return thread;
  };
  const requireOwned = async (id: string): Promise<Thread> => {
    const thread = await requireAccessible(id);
    if (thread.pluginOwnership?.pluginInstanceId !== input.pluginInstanceId && !(await hasPluginBinding(thread.id))) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} does not own thread ${id}`);
    }
    return thread;
  };

  const findBound = async (key: string): Promise<Thread | null> => {
    const binding = await input.bindingStore.getByExternal(input.pluginId, key);
    if (!binding || binding.userId !== input.ownerUserId) return null;
    return readThread(binding.threadId);
  };

  const ensure = async (key: string, requestedTitle: string): Promise<PluginThreadSummary> => {
    const previous = ensureTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    ensureTails.set(key, current);
    await previous.catch(() => undefined);
    try {
      const existing = await findBound(key);
      if (existing) {
        await input.threadStore.updatePluginOwnership(existing.id, {
          v: 1,
          pluginInstanceId: input.pluginInstanceId,
        });
        return summary(existing);
      }

      const thread = await input.threadStore.create(input.ownerUserId, requestedTitle, input.projectPath);
      await input.threadStore.updatePluginOwnership(thread.id, { v: 1, pluginInstanceId: input.pluginInstanceId });
      await input.bindingStore.bind(input.pluginId, key, thread.id, input.ownerUserId);
      const stored = await input.threadStore.get(thread.id);
      if (!stored) {
        throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `thread ${thread.id} disappeared during ensure`);
      }
      return summary(stored);
    } finally {
      release();
      if (ensureTails.get(key) === current) ensureTails.delete(key);
    }
  };

  return {
    async list(options = {}) {
      requireGrant('thread.listMetadata');
      if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new TypeError('list options must be an object');
      if (Object.keys(options).some((key) => key !== 'limit' && key !== 'before'))
        throw new TypeError('list options must contain limit or before only');
      const limit = boundedLimit(options.limit ?? 50, 50);
      const before = listCursor(options.before);
      const visible = await input.threadStore.list(input.ownerUserId);
      const accessible: Thread[] = [];
      for (const thread of [...visible].sort(compareThreadPosition)) {
        if (accessible.length === limit) break;
        if (before && compareThreadPosition(thread, before) <= 0) continue;
        if (!thread.deletedAt && (await canAccess(thread))) accessible.push(thread);
      }
      return Promise.all(accessible.map(summary));
    },
    async readMessages(id, options) {
      requireGrant('thread.readContent');
      const thread = await requireAccessible(id);
      if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new TypeError('message options must be an object');
      const limit = boundedLimit(options.limit, 500);
      const before = options.before;
      if (
        before !== undefined &&
        (!before ||
          typeof before !== 'object' ||
          Array.isArray(before) ||
          Object.keys(before).some((key) => key !== 'timestamp' && key !== 'id') ||
          !Number.isSafeInteger(before.timestamp) ||
          before.timestamp < 0 ||
          typeof before.id !== 'string' ||
          !before.id ||
          before.id.length > 256 ||
          before.id !== before.id.trim())
      )
        throw new TypeError('before must contain a non-negative timeline timestamp and message id');
      if (!input.messageStore) return projectionUnavailable();
      return projectThreadMessages(input.messageStore, thread.id, input.ownerUserId, { ...options, limit });
    },
    async getCats(id) {
      requireGrant('thread.listMetadata');
      const thread = await requireAccessible(id);
      if (!input.cats) return projectionUnavailable();
      return projectThreadCats(input.cats, await input.threadStore.getParticipantsWithActivity(thread.id));
    },
    async get(id) {
      requireGrant('thread.readContent');
      const thread = await readThread(id);
      return thread && (await canAccess(thread)) ? summary(thread) : null;
    },
    async create(value) {
      requireGrant('thread.write');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('thread input must be an object');
      const thread = await input.threadStore.create(input.ownerUserId, title(value.title), input.projectPath);
      await input.threadStore.updatePluginOwnership(thread.id, { v: 1, pluginInstanceId: input.pluginInstanceId });
      const stored = await input.threadStore.get(thread.id);
      if (!stored) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'created thread disappeared');
      return summary(stored);
    },
    async update(id, patch) {
      requireGrant('thread.write');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        throw new TypeError('thread patch must be an object');
      const keys = Object.keys(patch);
      if (!keys.length || keys.some((key) => key !== 'title' && key !== 'preferredCats'))
        throw new TypeError('thread patch must contain title or preferredCats only');
      const owned = await requireOwned(threadId(id));
      const nextTitle = Object.hasOwn(patch, 'title') ? title(patch.title) : undefined;
      const preferred = Object.hasOwn(patch, 'preferredCats')
        ? validatePreferredCats(patch.preferredCats, input.cats)
        : undefined;
      if (nextTitle !== undefined) await input.threadStore.updateTitle(owned.id, nextTitle);
      if (preferred !== undefined) await input.threadStore.updatePreferredCats(owned.id, preferred);
      const stored = await input.threadStore.get(owned.id);
      if (!stored)
        throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `thread ${owned.id} disappeared during update`);
      return summary(stored);
    },
    async findByKey(value) {
      requireGrant('thread.listMetadata');
      const thread = await findBound(bindingKey(value));
      return thread ? summary(thread) : null;
    },
    async ensureByKey(value, request) {
      requireGrant('thread.write');
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('thread ensure input must be an object');
      }
      return ensure(bindingKey(value), title(request.title));
    },
    async bind(value, id) {
      requireGrant('thread.write');
      const key = bindingKey(value);
      const thread = await requireAccessible(threadId(id));
      const binding = await input.bindingStore.bind(input.pluginId, key, thread.id, input.ownerUserId);
      return bindingSummary(binding);
    },
    async unbind(value) {
      requireGrant('thread.write');
      return input.bindingStore.remove(input.pluginId, bindingKey(value));
    },
    async listBindings() {
      requireGrant('thread.listMetadata');
      const bindings = await input.bindingStore.listByUser(input.pluginId, input.ownerUserId);
      return bindings.map(bindingSummary);
    },
    async ensureSystemThread() {
      requireGrant('thread.write');
      return ensure(SYSTEM_BINDING_KEY, title(input.systemThreadTitle));
    },
  };
}
