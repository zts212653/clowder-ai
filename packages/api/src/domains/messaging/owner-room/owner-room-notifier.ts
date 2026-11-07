import {
  emitLifecycleMessageUpdated,
  type LifecycleCommitMarker,
} from '../../cats/services/agents/invocation/lifecycle-message-update.js';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { threadMessageAppendedHint } from './thread-message-appended-hint.js';

/**
 * PR-3a (docs/plans/2026-11-05-hub-pr3-background-thread-contract.md 2.4, 3.8, 3.10): who hears the
 * owner-room events this PR adds.
 *
 * A message is stored under the identity that wrote it, which is not always the person who reads the
 * thread: a scheduler's web digest or memory-curation receipt is stored as `scheduler` inside a
 * person's thread, and a scheduler-owned run's reply belongs to `scheduler` too. The page that shows
 * the thread joins only its person's user room, so these events go to the thread's owner — the
 * identity whose Sidebar lists the thread (`threadStore.list(userId)` reads `createdBy`). Storage
 * identity is unchanged. When the owner cannot be read the storage identity is used, which is what
 * every owner-room event did before; nothing is ever broadcast wider.
 */
export interface OwnerRoomSocket {
  emitToUser(userId: string, event: string, data: unknown): void;
}

export interface OwnerRoomThreads {
  get(threadId: string): Thread | null | Promise<Thread | null>;
}

export interface OwnerRoomNotifierDeps {
  /** Late-bound: the socket manager is created after the message store. */
  socket(): OwnerRoomSocket | null | undefined;
  /** Late-bound: the thread store is created after the message store. */
  threads(): OwnerRoomThreads | null | undefined;
  /** An owner that could not be read (`owner`) or a delivery that threw (`deliver`). */
  onError(error: unknown, message: StoredMessage, stage: 'owner' | 'deliver'): void;
}

export interface OwnerRoomNotifier {
  /** A lifecycle terminal the store seam committed (`applied`) or replayed. */
  lifecycleCommitted(message: StoredMessage, commit: LifecycleCommitMarker): Promise<void>;
  /** A newly stored message; standalone ones produce the body-free `thread_message_appended` hint. */
  messageAppended(message: StoredMessage): Promise<void>;
}

export function createOwnerRoomNotifier(deps: OwnerRoomNotifierDeps): OwnerRoomNotifier {
  async function ownerOf(message: StoredMessage): Promise<string> {
    const threads = deps.threads();
    if (!threads) return message.userId;
    try {
      const thread = await threads.get(message.threadId);
      return thread?.createdBy || message.userId;
    } catch (error) {
      deps.onError(error, message, 'owner');
      return message.userId;
    }
  }

  async function deliver(message: StoredMessage, send: (socket: OwnerRoomSocket, userId: string) => void) {
    const userId = await ownerOf(message);
    const socket = deps.socket();
    if (!socket) return;
    try {
      send(socket, userId);
    } catch (error) {
      deps.onError(error, message, 'deliver');
    }
  }

  return {
    lifecycleCommitted: (message, commit) =>
      deliver(message, (socket, userId) => emitLifecycleMessageUpdated(socket, userId, message, commit)),
    messageAppended: async (message) => {
      const hint = threadMessageAppendedHint(message);
      if (!hint) return;
      await deliver(message, (socket, userId) => socket.emitToUser(userId, 'thread_message_appended', hint));
    },
  };
}
