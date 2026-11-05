import { getConnectorDefinition, type MessageFrom } from '@cat-cafe/shared';

/** The source actor is independent of the human who forwarded the bundle. */
export function messageBundleSenderLabel(
  from: MessageFrom,
  createdBy: string,
  forwarderName: string,
  getCatLabel: (catId: string) => string,
): string {
  switch (from.kind) {
    case 'agent':
      return getCatLabel(from.catId);
    case 'user':
      return from.userId === createdBy ? forwarderName : from.userId;
    case 'external': {
      const connector = getConnectorDefinition(from.connectorId)?.displayName ?? from.connectorId;
      const actor = from.sender?.name ?? from.sender?.id;
      return actor ? `${connector} · ${actor}` : connector;
    }
    case 'plugin':
      return '插件';
    case 'system':
      return from.service;
  }
}
