import type {
  CollectiveConnector,
  ConnectorProjection,
  ConnectorRouteReceipt,
  HostRouteConfig,
} from '@cat-cafe/collective-connector';
import type { CollectiveEventEnvelope, CollectiveSourceIdentity } from '@cat-cafe/shared';
import { selectChannelListener } from './collective-channel-listening.js';
import { attentionSource, ingressError } from './collective-ingress-routing.js';

type ThreadReceipt = Extract<ConnectorRouteReceipt, { kind: 'thread_message' }>;
export async function routeCollectiveChannelEvent(input: {
  connection: ConnectorProjection;
  route: HostRouteConfig;
  event: CollectiveEventEnvelope;
  connector: Pick<CollectiveConnector, 'readParticipationContext'> &
    Partial<Pick<CollectiveConnector, 'readWorkRoutingContext'>>;
  isCatAvailable: (catId: string) => boolean;
  persistVisible: (threadId: string) => Promise<ThreadReceipt>;
  persistAgent: (threadId: string, catId: string, source: CollectiveSourceIdentity) => Promise<ThreadReceipt>;
  requireThread: (threadId: string) => Promise<{ participants?: readonly string[] }>;
}): Promise<ThreadReceipt> {
  const { connection, route, event } = input;
  const channelId = event.location?.channelId ?? (event.target.kind === 'channel' ? event.target.channelId : undefined);
  const channelRoutes = route.channelRoutes ?? {};
  const channelRoute = channelId ? channelRoutes[channelId] : undefined;
  if (Object.keys(channelRoutes).length && !channelRoute) {
    throw ingressError('ROUTE_CHANNEL_UNCONFIGURED', 'Channel has no Host endpoint');
  }
  const threadId = channelRoute?.threadId ?? route.defaultIngressThreadId;
  if (!channelId || !channelRoute) return input.persistVisible(threadId);
  let listener: Awaited<ReturnType<typeof selectChannelListener>>;
  try {
    listener = await selectChannelListener({
      event,
      route,
      isCatAvailable: input.isCatAvailable,
      readRelated: () => {
        const read = input.connector.readWorkRoutingContext;
        if (!read)
          throw ingressError('COLLECTIVE_ROUTING_CONTEXT_UNAVAILABLE', 'Host Work routing context is unavailable');
        return read.call(input.connector, connection.connectionId, event.eventId);
      },
    });
    if (listener) {
      const thread = await input.requireThread(threadId);
      if (!thread.participants?.includes(listener.catId))
        throw ingressError('ROUTE_CAT_NOT_IN_THREAD', 'Selected Cat is not a participant in the receiving Thread');
      const source = attentionSource(event, connection.connectionId, listener.catId, route.revision);
      await input.connector.readParticipationContext(source, 0, 1);
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ROUTE_CAT_UNAVAILABLE' && code !== 'ROUTE_CAT_NOT_IN_THREAD') throw error;
    const receipt = await input.persistVisible(threadId);
    return { ...receipt, attention: { request: 'channel_listening' as const, state: 'failed' as const, reason: code } };
  }
  if (!listener) {
    const receipt = await input.persistVisible(threadId);
    return event.attentionRequest === 'response_requested'
      ? { ...receipt, attention: { request: 'response_requested' as const, state: 'unclaimed' as const } }
      : receipt;
  }
  const source = attentionSource(event, connection.connectionId, listener.catId, route.revision);
  const receipt = await input.persistAgent(threadId, listener.catId, source);
  return listener.reason === 'response_request'
    ? {
        ...receipt,
        attention: {
          request: 'response_requested' as const,
          state: 'wake_queued' as const,
          catId: listener.catId,
          interestRevision: listener.revision,
        },
      }
    : receipt;
}
