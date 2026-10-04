import {
  type CollectiveConnector,
  defaultDesiredParticipation,
  type HostRouteConfig,
} from '@cat-cafe/collective-connector';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  currentParticipationCats,
  type ParticipationCat,
  preserveInitialExclusions,
} from '../domains/plugin/builtin-runtime/collective-participation-reconciler.js';
import { ownerRequestExecution } from './collective-owner-request-progress.js';

interface ViewOptions {
  readonly cats: () => readonly ParticipationCat[];
  readonly threads: Pick<IThreadStore, 'list'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly tasks: Pick<ITaskStore, 'listByKind'>;
}

interface ViewAuthority {
  readonly connector: Pick<CollectiveConnector, 'listInbox' | 'isParticipationPublished'>;
  readonly connection: Awaited<ReturnType<CollectiveConnector['getProjection']>>;
  readonly route?: HostRouteConfig;
  readonly userId: string;
}

export async function collectiveOwnerParticipationView(options: ViewOptions, auth: ViewAuthority) {
  const inbox = await auth.connector.listInbox(auth.connection.connectionId);
  const replies = new Map<string, (typeof inbox)[number]['event'][]>();
  for (const { event } of inbox) {
    if (!event.replyToEventId) continue;
    const group = replies.get(event.replyToEventId) ?? [];
    group.push(event);
    replies.set(event.replyToEventId, group);
  }
  const sources = new Set(
    inbox.flatMap((item) =>
      item.routeReceipt?.kind === 'thread_message' ? [`message:${item.routeReceipt.messageId}`] : [],
    ),
  );
  const tasks = (await options.tasks.listByKind('work')).filter(
    (task) => task.userId === auth.userId && task.entrustedWork?.admission.sourceRefs.some((ref) => sources.has(ref)),
  );
  const published = await auth.connector.isParticipationPublished(auth.connection.connectionId).catch(() => false);
  const registeredCats = options.cats();
  const profiles = new Map(registeredCats.map((cat) => [cat.id, cat]));
  const cats = currentParticipationCats(auth.route?.observedEligibility ?? {}, registeredCats);
  const ownerThreads = (await options.threads.list(auth.userId)).filter(
    (thread) => !thread.deletedAt && thread.createdBy === auth.userId,
  );
  const ownerThreadById = new Map(ownerThreads.map((thread) => [thread.id, thread]));
  const requestItems = inbox.filter(
    (item) =>
      (item.event.recipient?.kind === 'agent' && item.event.recipient.connectionId === auth.connection.connectionId) ||
      item.event.attentionRequest === 'response_requested',
  );
  const recentRequestIds = new Set(requestItems.slice(-20).map((item) => item.event.eventId));
  const requests = await Promise.all(
    requestItems.map(async (item) => {
      const receipt = item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt : undefined;
      const thread = receipt ? ownerThreadById.get(receipt.threadId) : undefined;
      const recipient = item.event.recipient;
      const response = [...(replies.get(item.event.eventId) ?? [])]
        .reverse()
        .find(
          (reply) =>
            recipient?.kind !== 'agent' ||
            (reply.actor.kind === 'agent' &&
              reply.actor.provenance.connectionId === recipient.connectionId &&
              reply.actor.provenance.catId === recipient.agentId),
        );
      const execution = recentRequestIds.has(item.event.eventId)
        ? await ownerRequestExecution(item, thread, options.messages, auth.userId, auth.connection.connectionId)
        : undefined;
      return {
        event: item.event,
        delivery: item.disposition,
        failure: item.routeFailure,
        messageId: receipt?.messageId,
        attention: receipt?.attention,
        response,
        ...(thread ? { privateThread: { id: thread.id, title: thread.title } } : {}),
        ...(execution ? { execution } : {}),
      };
    }),
  );
  return {
    connection: auth.connection,
    revision: auth.route?.revision ?? 0,
    cats: cats.map((cat) => {
      const profile = cat.configured ? profiles.get(cat.id) : undefined;
      return {
        id: cat.id,
        displayName: cat.displayName,
        configured: cat.configured,
        eligible: cat.eligible,
        supported: cat.eligible,
        ...(profile?.avatar ? { avatar: profile.avatar } : {}),
        ...(profile?.roleDescription ? { roleDescription: profile.roleDescription } : {}),
        ...(profile?.defaultModel ? { defaultModel: profile.defaultModel } : {}),
      };
    }),
    bindings: auth.route?.agentRoutes ?? {},
    desiredParticipation: preserveInitialExclusions(
      auth.route?.desiredParticipation ?? defaultDesiredParticipation(),
      auth.route,
      auth.connection.initialExcludedCatIds,
    ),
    observedEligibility: auth.route?.observedEligibility ?? {},
    channelRoutes: auth.route?.channelRoutes ?? {},
    standingInterests: auth.route?.standingInterests ?? {},
    attentionRevision: auth.route?.attentionRevision ?? 0,
    reconcileRequired:
      !auth.route ||
      hasUnavailableEndpoints(auth.route, ownerThreadById) ||
      cats.some((cat) => eligibilityChanged(auth.route, cat)),
    published,
    threads: ownerThreads.map((thread) => ({ id: thread.id, title: thread.title, participants: thread.participants })),
    requests,
    tasks: tasks.flatMap((task) => {
      const work = task.entrustedWork;
      return work
        ? [
            {
              id: task.id,
              title: task.title,
              threadId: task.threadId,
              status: task.status,
              revision: work.revision,
              closure: work.closure.state,
              sourceRefs: work.admission.sourceRefs,
            },
          ]
        : [];
    }),
  };
}

function hasUnavailableEndpoints(
  route: HostRouteConfig,
  ownerThreads: ReadonlyMap<string, { readonly participants: readonly string[] }>,
) {
  if ([route.defaultIngressThreadId, route.humanNotificationThreadId].some((id) => !ownerThreads.has(id))) return true;
  return Object.values(route.channelRoutes ?? {}).some((endpoint) => {
    const thread = ownerThreads.get(endpoint.threadId);
    return (
      !thread ||
      Object.keys(endpoint.participants).some(
        (catId) => !thread.participants.some((participant) => participant === catId),
      )
    );
  });
}

function eligibilityChanged(
  route: HostRouteConfig | undefined,
  cat: { id: string; displayName: string; configured: boolean; eligible: boolean; profileFingerprint?: string },
) {
  const observed = route?.observedEligibility?.[cat.id];
  return (
    !observed ||
    observed.displayName !== cat.displayName ||
    observed.configured !== cat.configured ||
    observed.eligible !== cat.eligible ||
    observed.profileFingerprint !== cat.profileFingerprint
  );
}
