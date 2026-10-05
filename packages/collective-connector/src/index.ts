export type { StandingInterestInput } from './attention-custody.js';
export { type ChannelListeningInput, channelListeningInputSchema } from './channel-listening-custody.js';
export {
  type AssignedWorkAuthorityScope,
  CollectiveConnector,
  type ConnectorSyncHooks,
} from './connector.js';
export type { CollectiveConnectorOptions } from './connector-options.js';
export type { ChannelListening } from './host-route-state.js';
export { defaultDesiredParticipation, desiredParticipationSchema } from './host-route-state.js';
export { resolveMaterializedParticipation } from './participation-custody.js';
export type { ConnectorProjection } from './projection.js';
export { ConnectorTransportError } from './service-client.js';
export type {
  AgentHostRoute,
  ChannelHostRoute,
  ConnectorInboxItem,
  ConnectorOutboxItem,
  ConnectorRouteFailure,
  ConnectorRouteReceipt,
  DesiredParticipation,
  HostRouteConfig,
  ObservedCatEligibility,
  SetHostRouteInput,
  StandingInterest,
  VerifiedAgent,
  WorkResultArtifactSnapshot,
} from './state.js';
export type { CollectiveWorkAcceptanceInput } from './work-acceptance-custody.js';
export type { CollectiveWorkContinuationInput } from './work-continuation-custody.js';
export type {
  CollectiveWorkResultPublication,
  CollectiveWorkResultPublicationCandidate,
} from './work-result-publication.js';
