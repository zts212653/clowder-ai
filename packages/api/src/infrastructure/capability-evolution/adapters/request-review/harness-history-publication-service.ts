import type { CallbackPrincipal, HarnessHistoryPublicationCommand } from '@cat-cafe/shared';
import type { EvolutionPreparationDependencies } from '../../program-preparation-contract.js';
import type { EvolutionProgramService } from '../../program-service.js';
import { resolveAuthorizedExplorationProgram } from '../../read-model/program-exploration-access.js';
import type { ProgramAdapterRegistry } from '../program-adapter-registry.js';
import {
  HarnessHistoryPublicationError,
  type HarnessHistoryPublicationOwner,
} from './harness-history-publication-owner.js';

/** F314's writer authority; the Program remains a read-only ownership lookup. */
export class HarnessHistoryPublicationService {
  constructor(
    private readonly options: {
      owner: HarnessHistoryPublicationOwner;
      service: Pick<EvolutionProgramService, 'get'>;
      adapterRegistry: ProgramAdapterRegistry;
      dependencies: Pick<EvolutionPreparationDependencies, 'threadStore' | 'invocationReader'>;
    },
  ) {}

  async status(programId: string, userId: string) {
    const { input } = await resolveAuthorizedExplorationProgram(this.options, programId, userId);
    return this.options.owner.status(input);
  }

  async publish(programId: string, principal: CallbackPrincipal, command: HarnessHistoryPublicationCommand) {
    if (principal.kind !== 'invocation') throw new HarnessHistoryPublicationError('invocation_auth_required', 403);
    const { input } = await resolveAuthorizedExplorationProgram(this.options, programId, principal.userId);
    const record = await this.options.dependencies.invocationReader.peekRecord(principal.invocationId);
    if (
      !record ||
      record.invocationId !== principal.invocationId ||
      record.userId !== principal.userId ||
      record.catId !== principal.catId ||
      record.threadId !== principal.threadId
    )
      throw new HarnessHistoryPublicationError('history_actor_invalid', 403);
    if (record.state !== 'active') throw new HarnessHistoryPublicationError('history_actor_inactive', 409);
    const thread = await this.options.dependencies.threadStore.get(record.threadId);
    if (!thread || thread.deletedAt) throw new HarnessHistoryPublicationError('history_source_unavailable', 410);
    if (thread.createdBy !== record.userId) throw new HarnessHistoryPublicationError('history_actor_invalid', 403);
    return this.options.owner.publish(input, command, {
      actorRef: `cat:${record.catId}`,
      originRef:
        `thread:${record.threadId}:invocation:${record.invocationId}` +
        (record.originTriggerMessageId ? `:message:${record.originTriggerMessageId}` : ''),
    });
  }
}
