import type { IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
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

const MAX_THREAD_ID_LENGTH = 500;
const MAX_THREAD_TITLE_LENGTH = 200;
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
  create(input: {
    readonly title: string;
    readonly parentThreadId?: string;
    readonly participants?: readonly string[];
  }): Promise<PluginThreadSummary>;
  update(
    threadId: string,
    patch: { readonly title?: string; readonly preferredCats?: readonly string[] },
  ): Promise<PluginThreadSummary>;
  addParticipants(input: {
    readonly threadId: string;
    readonly catIds: readonly string[];
  }): Promise<PluginThreadSummary>;
}

export interface PluginThreadHostDeps extends PluginThreadProjectionDeps {
  readonly threadDeepLinkUrl: (threadId: string) => string;
  readonly pluginId: string;
  readonly ownerUserId: string;
  readonly projectPath: string;
  readonly threadStore: IThreadStore;
  readonly assertCurrent?: () => void;
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
    addParticipants: unavailable,
  };
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function title(value: unknown): string {
  return boundedString(value, 'thread title', MAX_THREAD_TITLE_LENGTH);
}

function threadId(value: unknown): string {
  return boundedString(value, 'threadId', MAX_THREAD_ID_LENGTH);
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

/** Ordinary Host thread operations; business mappings belong to plugin storage. */
export function createPluginThreadHost(input: PluginThreadHostDeps): PluginThreadHost {
  const summary = (thread: Thread) =>
    projectThread(thread, input.ownerUserId, input.backlogStore, input.threadDeepLinkUrl);
  const requireService = () => {
    input.assertCurrent?.();
  };

  const readThread = async (id: string): Promise<Thread | null> => {
    const thread = await input.threadStore.get(threadId(id));
    input.assertCurrent?.();
    return thread?.deletedAt ? null : thread;
  };
  const requireThread = async (id: string): Promise<Thread> => {
    const thread = await readThread(id);
    if (!thread) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `thread ${id} does not exist`);
    return thread;
  };

  return {
    async list(options = {}) {
      requireService();
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
        if (!thread.deletedAt) accessible.push(thread);
      }
      return Promise.all(accessible.map(summary));
    },
    async readMessages(id, options) {
      requireService();
      const thread = await requireThread(id);
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
      requireService();
      const thread = await requireThread(id);
      if (!input.cats) return projectionUnavailable();
      return projectThreadCats(input.cats, await input.threadStore.getParticipantsWithActivity(thread.id));
    },
    async get(id) {
      requireService();
      const thread = await readThread(id);
      return thread ? summary(thread) : null;
    },
    async create(value) {
      requireService();
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !['title', 'parentThreadId', 'participants'].includes(key))
      )
        throw new TypeError('thread input must contain title, parentThreadId or participants only');
      const requestedTitle = title(value.title);
      const participants =
        value.participants === undefined ? [] : validatePreferredCats(value.participants, input.cats);
      const parent = value.parentThreadId === undefined ? undefined : await requireThread(value.parentThreadId);
      input.assertCurrent?.();
      const thread = await input.threadStore.create(
        input.ownerUserId,
        requestedTitle,
        parent?.projectPath ?? input.projectPath,
        parent?.id,
      );
      if (participants.length) await input.threadStore.addParticipants(thread.id, participants);
      const stored = await input.threadStore.get(thread.id);
      if (!stored) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'created thread disappeared');
      return summary(stored);
    },
    async update(id, patch) {
      requireService();
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        throw new TypeError('thread patch must be an object');
      const keys = Object.keys(patch);
      if (!keys.length || keys.some((key) => key !== 'title' && key !== 'preferredCats'))
        throw new TypeError('thread patch must contain title or preferredCats only');
      const owned = await requireThread(threadId(id));
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
    async addParticipants(value) {
      requireService();
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'threadId' && key !== 'catIds')
      )
        throw new TypeError('Expected threadId and catIds');
      const thread = await requireThread(value.threadId);
      const ids = validatePreferredCats(value.catIds, input.cats);
      const missing = ids.filter((id) => !thread.participants.includes(id));
      if (missing.length) await input.threadStore.addParticipants(thread.id, missing);
      return summary(await requireThread(thread.id));
    },
  };
}
