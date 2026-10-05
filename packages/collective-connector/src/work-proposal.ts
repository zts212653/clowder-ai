import type { CollectiveSourceIdentity } from '@cat-cafe/shared';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import type { VerifiedAgent } from './state.js';

export async function proposeVerifiedCollectiveWork(input: {
  readonly persistence: ConnectorPersistence;
  readonly service: CollectiveServiceClient;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  readonly source: CollectiveSourceIdentity;
  readonly requestId: string;
  readonly agent: VerifiedAgent;
  readonly proposal: { readonly title?: string; readonly intendedOutcome?: string; readonly requestKind?: string };
}) {
  const { connection, binding, credential } = requireParticipation(input.persistence.snapshot(), input.source);
  if (
    input.agent.catId !== input.source.catId ||
    input.agent.agentId !== input.source.catId ||
    input.agent.displayName !== binding.displayName ||
    !(await input.verifyAgent(input.agent))
  ) {
    throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Host could not verify the current Cat proposal');
  }
  const proposal = await input.service.proposeWork(connection.serviceUrl, credential, {
    serviceInstanceId: input.source.serviceInstanceId,
    collectiveId: input.source.collectiveId,
    connectionId: input.source.connectionId,
    sourceEventId: input.source.eventId,
    requestId: input.requestId,
    catId: input.source.catId,
    participationRevision: input.source.participationRevision,
    ...(input.proposal.requestKind ? { requestKind: input.proposal.requestKind } : {}),
    ...(input.proposal.title ? { title: input.proposal.title } : {}),
    ...(input.proposal.intendedOutcome ? { intendedOutcome: input.proposal.intendedOutcome } : {}),
  });
  requireParticipation(input.persistence.snapshot(), input.source);
  return proposal;
}
