import type { CatId } from '@cat-cafe/shared';
import type { A2ADispatchDispositionService } from '../../../../ball-custody/A2ADispatchDispositionService.js';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import { exactA2ASourceMessageIds } from './InvocationQueue.js';
import { createCrossThreadQueueEntryFromCustody } from './QueuedMessageCustodyCoordinator.js';
import type { StartupCustodyLog } from './QueuedMessageCustodyStartupTypes.js';

interface A2AReplacementPreflight {
  replacedTargetCats: Set<string>;
  /** A required source/event lookup was unavailable or inconsistent; preserve the row for retry. */
  recoveryDeferred: boolean;
}

export async function resolveReplacedA2ATargetCats(
  message: StoredMessage,
  current: QueuedMessageCustody,
  a2aDispatchDispositionService: Pick<A2ADispatchDispositionService, 'inspectHandoff'> | undefined,
  messageStore: IMessageStore,
  log: StartupCustodyLog,
): Promise<A2AReplacementPreflight> {
  const replaced = new Set<string>();
  const a2aTargetCats = current.pendingTargetCats.filter(
    (catId) => current.carrierByTargetCatId?.[catId]?.sourceCategory === 'a2a',
  );
  if (a2aTargetCats.length === 0) return { replacedTargetCats: replaced, recoveryDeferred: false };
  if (!a2aDispatchDispositionService) {
    log.warn(
      `[queue-custody-startup] A2A replacement preflight is unavailable for ${message.id}; ` +
        'preserving queued custody without provider recovery',
    );
    return { replacedTargetCats: replaced, recoveryDeferred: true };
  }

  const readThread = messageStore.getByThreadAfter?.bind(messageStore);
  if (!readThread) {
    log.warn(
      `[queue-custody-startup] queued source-group reader is unavailable for ${message.id}; ` +
        'preserving queued custody without provider recovery',
    );
    return { replacedTargetCats: replaced, recoveryDeferred: true };
  }
  let queuedThreadMessages: readonly StoredMessage[];
  try {
    queuedThreadMessages = await readThread(message.threadId, undefined, undefined, message.userId, {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
  } catch (error) {
    log.warn(
      `[queue-custody-startup] queued source-group read unavailable for ${message.id}; ` +
        `preserving queued custody without provider recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { replacedTargetCats: replaced, recoveryDeferred: true };
  }

  for (const catId of a2aTargetCats) {
    const carrier = current.carrierByTargetCatId?.[catId];
    if (!carrier) continue;
    try {
      const groupSources = queuedThreadMessages.filter((candidate) => {
        const candidateCustody = candidate.queueCustody;
        return (
          candidate.deliveryStatus === 'queued' &&
          candidateCustody?.pendingTargetCats.includes(catId as CatId) === true &&
          candidateCustody.carrierByTargetCatId?.[catId]?.entryId === carrier.entryId
        );
      });
      if (!groupSources.some((candidate) => candidate.id === message.id)) {
        log.warn(
          `[queue-custody-startup] A2A replacement source group changed for ${message.id}/${catId}; ` +
            'preserving queued custody without provider recovery',
        );
        return { replacedTargetCats: replaced, recoveryDeferred: true };
      }
      const sourceMessageIds = exactA2ASourceMessageIds(
        createCrossThreadQueueEntryFromCustody(groupSources, carrier.entryId),
      );
      const inspections = await Promise.all(
        sourceMessageIds.map((sourceMessageId) =>
          a2aDispatchDispositionService.inspectHandoff({
            threadId: message.threadId,
            catId,
            sourceMessageId,
          }),
        ),
      );
      // Match live Queue preflight: every exact coalesced source must be
      // replaced before startup withdraws the target.
      if (inspections.every((inspection) => inspection.outcome === 'replaced')) replaced.add(catId);
    } catch (error) {
      log.warn(
        `[queue-custody-startup] A2A replacement preflight unavailable for ${message.id}/${catId}; ` +
          `preserving queued custody without provider recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { replacedTargetCats: replaced, recoveryDeferred: true };
    }
  }
  return { replacedTargetCats: replaced, recoveryDeferred: false };
}
