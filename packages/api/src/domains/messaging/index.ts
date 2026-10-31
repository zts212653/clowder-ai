/**
 * Plugin Messaging domain (K-1 / F288) — public surface.
 * Truth source: clowder-ai-plugins proposal §3.1 (189f25d).
 */

export type {
  AppendElementsRequest,
  AppendReceipt,
  CanonicalAudience,
  DraftAudience,
  ElementKind,
  EpistemicStatus,
  MessageAddress,
  MessageDraft,
  MessageElement,
  MessageEnvelope,
  MessageOutputEvent,
  MessagingErrorCode,
  SendReceipt,
} from '@clowder-ai/plugin-contract';
export { MESSAGING_BOUNDS } from '@clowder-ai/plugin-contract';
export type {
  HandleScope,
  PluginCallContext,
  ReadResult,
  SnapshotResult,
  SubscribeResult,
} from './contract/host-types.js';
export { MessagingError } from './contract/host-types.js';
export { projectEnvelope } from './envelope.js';
export type { IssueConnectorBindingHandleInput, IssueThreadHandleInput } from './handles.js';
export { createMessagingDomain, type MessagingDomainDeps, MessagingService } from './messaging-service.js';
