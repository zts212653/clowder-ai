import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const MAX_THREAD_KEY_LENGTH = 500;
const MAX_THREAD_ID_LENGTH = 500;
const MAX_THREAD_TITLE_LENGTH = 200;
const SYSTEM_BINDING_KEY = '__plugin_system_thread__';

export interface PluginThreadSummary {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface PluginThreadBindingSummary {
  readonly key: string;
  readonly threadId: string;
  readonly createdAt: number;
}

export interface PluginThreadHost {
  get(threadId: string): Promise<PluginThreadSummary | null>;
  create(input: { readonly title: string }): Promise<PluginThreadSummary>;
  update(threadId: string, patch: { readonly title: string }): Promise<PluginThreadSummary>;
  findByKey(key: string): Promise<PluginThreadSummary | null>;
  ensureByKey(key: string, input: { readonly title: string }): Promise<PluginThreadSummary>;
  bind(key: string, threadId: string): Promise<PluginThreadBindingSummary>;
  unbind(key: string): Promise<boolean>;
  listBindings(): Promise<readonly PluginThreadBindingSummary[]>;
  ensureSystemThread(): Promise<PluginThreadSummary>;
}

export interface PluginThreadHostDeps {
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

function summary(thread: Thread): PluginThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    lastActiveAt: thread.lastActiveAt,
  };
}

function bindingSummary(binding: {
  readonly externalChatId: string;
  readonly threadId: string;
  readonly createdAt: number;
}): PluginThreadBindingSummary {
  return { key: binding.externalChatId, threadId: binding.threadId, createdAt: binding.createdAt };
}

/** Thin, caller-bound projection of the Host's existing thread and binding stores. */
export function createPluginThreadHost(input: PluginThreadHostDeps): PluginThreadHost {
  const ensureTails = new Map<string, Promise<void>>();
  const requireGrant = (capability: 'thread.listMetadata' | 'thread.readContent' | 'thread.write') => {
    if (!input.effectiveGrants.includes(capability)) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} lacks ${capability}`);
    }
  };

  const readThread = async (id: string): Promise<Thread | null> => input.threadStore.get(threadId(id));
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
    return input.threadStore.get(binding.threadId);
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
      const owned = await requireOwned(threadId(id));
      await input.threadStore.updateTitle(owned.id, title(patch.title));
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
