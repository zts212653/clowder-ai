import type { CatId } from '@cat-cafe/shared';
import { categorizeThreadCats } from '../../../routes/thread-cats-core.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { getTimelineOrderTime, isSystemUserMessage } from '../../cats/services/stores/visibility.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export interface PluginThreadSummary {
  readonly id: string;
  readonly deepLinkUrl: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly preferredCats: readonly string[];
  readonly featureRefs: readonly string[];
}

export interface PluginThreadMessage {
  readonly id: string;
  /** Timeline-order time, paired with id for pagination; not necessarily authoring time. */
  readonly timestamp: number;
  readonly content: string;
  readonly sender: { readonly kind: 'owner' | 'cat' | 'system'; readonly catId?: string };
}

export interface PluginThreadHistoryCursor {
  readonly timestamp: number;
  readonly id: string;
}

export interface PluginThreadCat {
  readonly catId: string;
  readonly displayName: string;
  /** Public @mention forms from the Host roster; never credential aliases. */
  readonly aliases: readonly string[];
}

export interface PluginThreadCats {
  readonly participants: readonly (PluginThreadCat & {
    readonly lastMessageAt: number;
    readonly messageCount: number;
    readonly lastResponseHealthy?: boolean;
  })[];
  readonly routableNow: readonly PluginThreadCat[];
  readonly routableNotJoined: readonly PluginThreadCat[];
  readonly notRoutable: readonly PluginThreadCat[];
}

export interface PluginThreadProjectionDeps {
  readonly messageStore?: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  readonly backlogStore?: {
    get(
      id: string,
      userId: string,
    ): { readonly tags: readonly string[] } | null | Promise<{ readonly tags: readonly string[] } | null>;
  };
  readonly cats?: {
    getAllCatIds(): string[];
    getCatDisplayName(id: string): string;
    getCatAliases(id: string): readonly string[];
    isCatAvailable(id: string): boolean;
    getRegisteredServices(): Map<string, unknown>;
  };
}

export function projectionUnavailable(): never {
  throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host thread projection service is unavailable');
}

export function boundedLimit(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`limit must be an integer in 1..${maximum}`);
  }
  return value;
}

export async function projectThread(
  thread: Thread,
  ownerUserId: string,
  backlogStore: PluginThreadProjectionDeps['backlogStore'],
  threadDeepLinkUrl: (threadId: string) => string,
): Promise<PluginThreadSummary> {
  const backlog =
    thread.backlogItemId && backlogStore ? await backlogStore.get(thread.backlogItemId, ownerUserId) : null;
  const featureRefs = [
    ...new Set(
      (backlog?.tags ?? []).filter((tag) => /^feature:F\d+$/i.test(tag)).map((tag) => tag.slice(8).toUpperCase()),
    ),
  ];
  return {
    id: thread.id,
    deepLinkUrl: threadDeepLinkUrl(thread.id),
    title: thread.title,
    createdAt: thread.createdAt,
    lastActiveAt: thread.lastActiveAt,
    preferredCats: [...(thread.preferredCats ?? [])],
    featureRefs,
  };
}

export function projectThreadCats(
  cats: NonNullable<PluginThreadProjectionDeps['cats']>,
  participantActivity: Parameters<typeof categorizeThreadCats>[0]['participantActivity'],
): PluginThreadCats {
  const result = categorizeThreadCats({
    participantActivity,
    registeredServices: cats.getRegisteredServices(),
    allCatIds: cats.getAllCatIds(),
    getCatDisplayName: cats.getCatDisplayName,
    isCatAvailable: cats.isCatAvailable,
  });
  const aliases = <T extends { catId: string }>(entry: T) => ({
    ...entry,
    aliases: [...cats.getCatAliases(entry.catId)],
  });
  return {
    participants: result.participants.map(aliases),
    routableNow: result.routableNow.map(aliases),
    routableNotJoined: result.routableNotJoined.map(aliases),
    notRoutable: result.notRoutable.map(aliases),
  };
}

export function validatePreferredCats(value: unknown, cats: PluginThreadProjectionDeps['cats']): CatId[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some((id) => typeof id !== 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError('preferredCats must be a unique array of canonical cat ids, at most 50');
  }
  if (value.length === 0) return [];
  if (!cats) return projectionUnavailable();
  const ids = new Set(cats.getAllCatIds());
  const registered = cats.getRegisteredServices();
  if (value.some((id) => !ids.has(id) || !cats.isCatAvailable(id) || !registered.has(id))) {
    throw new TypeError('preferredCats contains an unknown or unavailable cat');
  }
  return [...value] as CatId[];
}

export async function projectThreadMessages(
  store: NonNullable<PluginThreadProjectionDeps['messageStore']>,
  threadId: string,
  ownerUserId: string,
  options: { readonly before?: PluginThreadHistoryCursor; readonly limit: number },
): Promise<readonly PluginThreadMessage[]> {
  const rows =
    options.before === undefined
      ? await store.getByThread(threadId, options.limit, ownerUserId)
      : await store.getByThreadBefore(
          threadId,
          options.before.timestamp,
          options.limit,
          options.before.id,
          ownerUserId,
        );
  return [...rows]
    .sort((a, b) => getTimelineOrderTime(a) - getTimelineOrderTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((message) => ({
      id: message.id,
      timestamp: getTimelineOrderTime(message),
      content: message.content,
      sender: isSystemUserMessage(message)
        ? { kind: 'system' as const }
        : message.catId
          ? { kind: 'cat' as const, catId: message.catId }
          : { kind: 'owner' as const },
    }));
}
