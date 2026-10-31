import type { CatId, ConnectorSource, MessageFrom } from '@cat-cafe/shared';

/**
 * Synthetic connector identity used only when a legacy Redis row proves that
 * a connector source existed but its payload cannot be parsed. Treating that
 * row as a user message would grant it operator authority, so the fallback
 * deliberately remains in the non-user namespace.
 */
export const UNPARSEABLE_LEGACY_CONNECTOR_ID = 'legacy-unparseable-source';

export interface MessageFromSource {
  readonly from?: MessageFrom;
  readonly userId: string;
  readonly catId: CatId | null;
  readonly source?: ConnectorSource;
  readonly sourceParseFailure?: true;
  readonly origin?: 'stream' | 'callback' | 'briefing';
}

/**
 * Return the canonical sender identity for both current and legacy messages.
 *
 * New writes always persist `from`. The remaining branches are the single
 * compatibility boundary for pre-MessageFrom rows; callers must not repeat
 * legacy userId/catId/source inference.
 */
export function messageFrom(message: MessageFromSource): MessageFrom {
  if (message.from) return message.from;

  if (message.source) {
    return {
      kind: 'external',
      connectorId: message.source.connector,
      ...(message.source.sender ? { sender: message.source.sender } : {}),
    };
  }

  if (message.sourceParseFailure) {
    return { kind: 'external', connectorId: UNPARSEABLE_LEGACY_CONNECTOR_ID };
  }

  if (
    message.origin === 'briefing' ||
    ((message.userId === 'system' || message.userId === 'scheduler') &&
      (message.catId === 'system' || message.catId === null))
  ) {
    return {
      kind: 'system',
      service: message.origin === 'briefing' ? 'legacy-briefing' : message.userId,
    };
  }

  if (message.catId !== null) return { kind: 'agent', catId: message.catId };
  return { kind: 'user', userId: message.userId };
}
