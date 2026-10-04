import type { HostRouteConfig } from '@cat-cafe/collective-connector';
import type { CollectiveEventEnvelope, CollectiveWorkSourceContext } from '@cat-cafe/shared';
import { ingressError, selectStandingInterest } from './collective-ingress-routing.js';

/** Selects one public classification recipient; this creates neither Work nor private execution authority. */
export async function selectChannelListener(input: {
  event: CollectiveEventEnvelope;
  route: HostRouteConfig;
  isCatAvailable: (catId: string) => boolean;
  readRelated: () => Promise<CollectiveWorkSourceContext>;
}) {
  const channelId = input.event.location?.channelId;
  if (!channelId) return;
  const channel = input.route.channelRoutes[channelId];
  if (!channel) return;
  // Passive agent publications remain visible without recursively waking other Cafés.
  if (input.event.actor.kind === 'agent' && input.event.attentionRequest !== 'response_requested') return;
  if (input.event.replyToEventId) {
    const related = relatedListener(
      await input.readRelated(),
      channel.participants,
      input.isCatAvailable,
      input.route.attentionRevision,
    );
    if (related) return related;
  }
  const listening = input.route.channelListening?.[channelId];
  if (listening?.mode === 'all') {
    if (!channel.participants[listening.dutyCatId] || !input.isCatAvailable(listening.dutyCatId))
      throw ingressError('ROUTE_CAT_UNAVAILABLE', 'Configured duty Cat is unavailable');
    return { catId: listening.dutyCatId, reason: 'duty' as const, revision: listening.revision };
  }
  if (input.event.attentionRequest !== 'response_requested') return;
  const interest = selectStandingInterest(input.route, channelId, channel.participants, input.isCatAvailable);
  return interest
    ? { catId: interest.catId, reason: 'response_request' as const, revision: interest.revision }
    : undefined;
}

function relatedListener(
  context: CollectiveWorkSourceContext,
  participants: Readonly<Record<string, unknown>>,
  isCatAvailable: (catId: string) => boolean,
  revision: number,
) {
  const cats = [...new Set(context.matters.flatMap((work) => (work.assignment ? [work.assignment.catId] : [])))].sort();
  const catId = cats[0];
  if (!catId) return;
  if (!participants[catId] || !isCatAvailable(catId))
    throw ingressError('ROUTE_CAT_UNAVAILABLE', 'Current assigned Cat cannot classify this feedback');
  return {
    catId,
    reason: cats.length > 1 || context.hasMore ? ('matter_clarification' as const) : ('work_feedback' as const),
    revision,
  };
}
