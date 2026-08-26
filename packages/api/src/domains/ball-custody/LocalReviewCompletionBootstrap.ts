import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorCompletionService } from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { MessageStoreLocalReviewEvidenceProvider } from './LocalReviewEvidenceProvider.js';
import { LocalReviewVerdictService } from './LocalReviewVerdictService.js';

export interface LocalReviewCompletionBootstrapInput {
  messageStore: Pick<IMessageStore, 'getById'>;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
}

export interface LocalReviewVerdictBindingInput {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'getByIdentity' | 'recoverLocalReviewVerdict'>;
  completionService: Pick<ActionSuccessorCompletionService, 'complete'>;
  truthResolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>;
}

/**
 * Owns the local-review construction order without expanding the API entrypoint.
 * The evidence provider must exist before the subject resolver, while the verdict
 * producer binds only after the completion service closes that dependency cycle.
 */
export function createLocalReviewCompletionBootstrap(input: LocalReviewCompletionBootstrapInput) {
  const evidenceProvider = new MessageStoreLocalReviewEvidenceProvider(input.messageStore, input.invocationRecordStore);

  return {
    evidenceProvider,
    createVerdictService(binding: LocalReviewVerdictBindingInput): LocalReviewVerdictService {
      return new LocalReviewVerdictService({
        leaseStore: binding.leaseStore,
        evidenceProvider,
        truthResolver: binding.truthResolver,
        completeActionLease: (completionInput) => binding.completionService.complete(completionInput),
      });
    },
  };
}
