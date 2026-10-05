import { randomUUID } from 'node:crypto';
import { sessionUserIdForCookies } from '../../../../../infrastructure/session-auth.js';
import { resolveThreadAccess } from '../../../../cats/services/session/thread-access-policy.js';
import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import { isTimelinePublished, passesManagedHoldViewerBoundary } from '../../../../cats/services/stores/visibility.js';
import type { CompanionDecisionDestination } from './companion-unified-decisions.js';

interface DecisionSocket {
  handshake: { headers: { cookie?: string } };
  emit(event: string, destination: CompanionDecisionDestination): void;
}

export function createCompanionDecisionSocketDelivery(options: {
  ownerUserId: string;
  parseCookie(header: string): Record<string, string>;
  sockets(): Iterable<DecisionSocket>;
}) {
  const recipients = () =>
    [...options.sockets()].filter((socket) => {
      try {
        return (
          sessionUserIdForCookies(options.parseCookie(socket.handshake.headers.cookie ?? '')) === options.ownerUserId
        );
      } catch {
        return false;
      }
    });
  return {
    hasRecipient: () => recipients().length > 0,
    emit: (destination: CompanionDecisionDestination) => {
      const event = { ...destination, source: 'companion-decision' as const, eventId: randomUUID() };
      for (const socket of recipients()) socket.emit('thread:teleport', event);
    },
  };
}

interface Options {
  ownerUserId: string;
  messages: Pick<IMessageStore, 'getById'>;
  threads: Pick<IThreadStore, 'get' | 'list'>;
  assertCurrent(): Promise<void>;
  hasRecipient(): boolean;
  emit(destination: CompanionDecisionDestination): void;
}

export function createCompanionDecisionNavigation(options: Options) {
  const canOpenDecision = async (destination: CompanionDecisionDestination): Promise<boolean> => {
    const thread = await options.threads.get(destination.threadId);
    if (!thread || thread.deletedAt) return false;
    const access = await resolveThreadAccess({
      threadStore: options.threads,
      thread,
      userId: options.ownerUserId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (access.status !== 200) return false;
    const message = await options.messages.getById(destination.messageId);
    if (
      !message ||
      message.threadId !== thread.id ||
      message.userId !== options.ownerUserId ||
      message.deletedAt ||
      message.recall ||
      message.origin === 'briefing' ||
      !isTimelinePublished(message) ||
      !passesManagedHoldViewerBoundary(message, options.ownerUserId)
    )
      return false;
    return (
      destination.blockId === undefined ||
      (message.extra?.rich?.blocks.some((block) => block.id === destination.blockId) ?? false)
    );
  };
  return {
    canOpenDecision,
    async openDecision(destination: CompanionDecisionDestination): Promise<boolean> {
      if (!(await canOpenDecision(destination))) return false;
      await options.assertCurrent();
      if (!options.hasRecipient()) return false;
      // The synchronous delivery after this lease check cannot acquire renderer-selected coordinates.
      options.emit(destination);
      return true;
    },
  };
}
