import { isDeepStrictEqual } from 'node:util';
import { contentRuntimeControlTargetSchema } from '@cat-cafe/shared';
import type { InvocationQueue } from '../../../cats/services/agents/invocation/InvocationQueue.js';
import type { NativeControlCommand } from '../../../cats/services/agents/invocation/NativeControlReceipt.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import type { ContentModificationJournal } from '../journal.js';
import { ContentModificationJournalError } from '../journal-errors.js';
import type { ContentModificationService } from '../service.js';

export class ModificationRuntimeControlService {
  constructor(
    private readonly deps: {
      journal: ContentModificationJournal;
      requests: ContentModificationService;
      queue?: Pick<InvocationQueue, 'getEntrySnapshot'>;
      turns?: Pick<ITurnExecutionStore, 'get'>;
    },
  ) {}
  async confirm(requestId: string, raw: unknown, principal: MediaReviewPrincipal) {
    const target = contentRuntimeControlTargetSchema.parse(raw);
    const view = await this.deps.requests.read(requestId, principal);
    if (!view.record.control) throw new ContentModificationJournalError('invalid_progress');
    const prior = this.deps.journal.runtimeControls
      .list(requestId, principal.userId)
      .find((item) => item.target.kind === target.kind);
    if (prior) {
      if (!isDeepStrictEqual(prior.target, target)) throw new ContentModificationJournalError('operation_reused');
      return prior; // Same frozen object, including an unknown acknowledgement; never reselect a newer one.
    }
    const execution = view.execution;
    if (!execution) throw new ContentModificationJournalError('invalid_progress');
    if (target.kind === 'stop_execution') {
      if (
        !['running', 'withdrawn_running'].includes(execution.state) ||
        target.invocationId !== execution.invocationId ||
        target.executionId !== execution.parentInvocationId
      )
        throw new ContentModificationJournalError('invalid_progress');
    } else {
      if (target.entryId !== execution.queueEntryId || target.messageId !== execution.messageId)
        throw new ContentModificationJournalError('invalid_progress');
      const entry = this.deps.queue?.getEntrySnapshot(view.record.payload.threadId, principal.userId, target.entryId);
      if (
        !entry ||
        ![entry.messageId, ...(entry.mergedMessageIds ?? [])].includes(target.messageId) ||
        !entry.allTargetCats?.some((cat) => cat === view.record.payload.targetCatId)
      )
        throw new ContentModificationJournalError('invalid_progress');
      // The native DELETE performs the atomic exclusive-source check immediately before removal.
    }
    return this.deps.journal.runtimeControls.confirm(view.record, target);
  }
  async list(requestId: string, ownerUserId: string) {
    return Promise.all(
      this.deps.journal.runtimeControls.list(requestId, ownerUserId).map(async (action) => {
        if (action.target.kind !== 'stop_execution') return action;
        const turn = await this.deps.turns?.get(action.target.invocationId);
        const executionState =
          turn &&
          turn.parentInvocationId === action.target.executionId &&
          turn.threadId === action.threadId &&
          turn.catId === action.catId &&
          turn.userId === ownerUserId
            ? turn.status
            : ('unknown' as const);
        return { ...action, executionState };
      }),
    );
  }
  authorize(receiptRef: string, ownerUserId: string, command: NativeControlCommand) {
    const action = this.deps.journal.runtimeControls.get(receiptRef, ownerUserId);
    if (!action || action.threadId !== command.threadId) return false;
    const target = action.target;
    if (target.kind === 'stop_execution') {
      if (
        command.kind !== 'live' ||
        target.executionId !== command.executionId ||
        target.invocationId !== command.invocationId ||
        action.catId !== command.catId
      )
        return false;
    } else {
      if (command.kind !== 'queue' || target.entryId !== command.entryId) return false;
      if (
        target.kind === 'withdraw_single'
          ? command.messageId !== target.messageId || command.catId !== action.catId
          : command.messageId !== undefined || command.catId !== undefined
      )
        return false;
    }
    return true;
  }
  observe(receiptRef: string, ownerUserId: string, statusCode: number, acknowledged: boolean, code?: string) {
    return this.deps.journal.runtimeControls.observe(receiptRef, ownerUserId, statusCode, acknowledged, code);
  }
}
