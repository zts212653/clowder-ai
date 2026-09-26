import type {
  ConnectorContribution,
  IdentityContribution,
  MessageDraft,
  MessageSubscriptionContribution,
  PluginManifest,
} from '@clowder-ai/plugin-contract';
import { MessagingError } from '../../messaging/contract/host-types.js';

export function externalPluginIdentity(
  manifest: PluginManifest,
  declared: ReadonlyMap<string, IdentityContribution>,
  origin: Extract<NonNullable<MessageDraft['payload']['provenance']['origin']>, { kind: 'external' }>,
  requestedIdentityId: string | undefined,
): { readonly connector: string; readonly identity: IdentityContribution } {
  const contributions = manifest.contributions ?? [];
  const contribution =
    contributions.find(
      (candidate): candidate is MessageSubscriptionContribution =>
        candidate.type === 'message-subscription' && candidate.id === origin.connectorId,
    ) ??
    contributions.find(
      (candidate): candidate is ConnectorContribution =>
        candidate.type === 'connector' && candidate.id === origin.connectorId,
    );
  if (!contribution) {
    throw new MessagingError(
      'PERMISSION',
      `connector ${origin.connectorId} is not declared by this plugin as a message-subscription or connector`,
    );
  }
  const identityRef = contribution.type === 'message-subscription' ? contribution.binding : contribution.identityRef;
  const identity = declared.get(identityRef);
  if (!identity) throw new MessagingError('VALIDATION', 'connector identity declaration is missing');
  if (requestedIdentityId !== undefined && identity.id !== requestedIdentityId) {
    throw new MessagingError(
      'VALIDATION',
      `connector ${origin.connectorId} does not use identity ${requestedIdentityId}`,
    );
  }
  return { connector: contribution.id, identity };
}
