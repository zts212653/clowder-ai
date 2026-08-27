import type { MeetingArtifactDescriptor, MeetingIntake, MeetingIntakeChoices } from '@cat-cafe/shared';
import { MeetingIntakeError } from './errors.js';
import { createMeetingArtifactDescriptor } from './MeetingArtifactResourceService.js';
import type { MeetingIntakeService } from './MeetingIntakeService.js';
import type { MeetingIntakeStore } from './MeetingIntakeStore.js';
import type { SourceAccessLeaseService } from './SourceAccessLeaseService.js';

export interface ResolvedMeetingArtifact {
  readonly contentType: 'text/plain';
  readonly text: string;
  readonly provenance: {
    readonly sourceHandle: string;
    readonly trust: 'untrusted_external';
    readonly instructionPolicy: 'data_only';
  };
}

export interface MeetingArtifactDispatcher {
  deliver(input: { readonly intake: MeetingIntake; readonly artifact: MeetingArtifactDescriptor }): Promise<void>;
  retryPresentation(input: {
    readonly intake: MeetingIntake;
    readonly clientRequestId: string;
  }): Promise<MeetingPresentationRetryReceipt>;
}

export interface MeetingPresentationRetryReceipt {
  readonly sourceMessageId: string;
  readonly triggerMessageId: string;
  readonly queueEntryId: string | null;
  readonly opportunityId: string;
  readonly targetCatId: string;
  readonly deduped: boolean;
}

export interface MeetingIntakeActionServiceOptions {
  readonly store: MeetingIntakeStore;
  readonly meeting: MeetingIntakeService;
  readonly sources: SourceAccessLeaseService;
  readonly dispatcher: MeetingArtifactDispatcher;
  readonly now?: () => number;
}

type ActionFailure =
  | 'transcript_not_ready'
  | 'auth_required'
  | 'source_deleted'
  | 'route_unavailable'
  | 'execution_failed';

function sourceFailure(error: unknown): ActionFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'SOURCE_NOT_READY') return 'transcript_not_ready';
  if (code === 'SOURCE_AUTH_REQUIRED') return 'auth_required';
  if (code === 'SOURCE_DELETED') return 'source_deleted';
  return 'execution_failed';
}

function dispatchFailure(error: unknown): ActionFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'ROUTE_UNAVAILABLE' ? 'route_unavailable' : 'execution_failed';
}

const REPAIR_BY_CODE = {
  transcript_not_ready: { sourceState: 'not_ready', action: 'retry' },
  auth_required: { sourceState: 'auth_required', action: 'regrant' },
  source_deleted: { sourceState: 'deleted', action: 'manual_import' },
  route_unavailable: { sourceState: null, action: 'retry' },
  execution_failed: { sourceState: null, action: 'retry' },
} as const;

export class MeetingIntakeActionService {
  private readonly now: () => number;

  constructor(private readonly options: MeetingIntakeActionServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async confirm(
    ownerId: string,
    intakeId: string,
    expectedRevision: number,
    choices: MeetingIntakeChoices,
  ): Promise<MeetingIntake> {
    const confirmed = await this.confirmChoices(ownerId, intakeId, expectedRevision, choices);
    return this.executeFromSource(ownerId, confirmed.intakeId, confirmed.revision);
  }

  async confirmChoices(
    ownerId: string,
    intakeId: string,
    expectedRevision: number,
    choices: MeetingIntakeChoices,
  ): Promise<MeetingIntake> {
    await this.requireOwner(ownerId, intakeId, expectedRevision);
    return this.options.meeting.confirm(intakeId, expectedRevision, choices);
  }

  async dismiss(ownerId: string, intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    await this.requireOwner(ownerId, intakeId, expectedRevision);
    return this.options.meeting.dismiss(intakeId, expectedRevision);
  }

  async retry(ownerId: string, intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.requireOwner(ownerId, intakeId, expectedRevision);
    if (
      !current.repair ||
      (current.repair.action !== 'retry' && current.repair.action !== 'regrant') ||
      current.judgmentState !== 'confirmed' ||
      current.executionState !== 'failed'
    ) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'meeting intake is not retryable');
    }
    const queued = await this.write(current, {
      ...current,
      sourceState: 'ready',
      healthState: 'healthy',
      executionState: 'queued',
      repair: undefined,
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
    return this.executeFromSource(ownerId, intakeId, queued.revision);
  }

  async retryPresentation(
    ownerId: string,
    intakeId: string,
    expectedRevision: number,
    clientRequestId: string,
  ): Promise<{ readonly intake: MeetingIntake; readonly presentationRetry: MeetingPresentationRetryReceipt }> {
    const current = await this.requireOwner(ownerId, intakeId, expectedRevision);
    if (
      current.judgmentState !== 'confirmed' ||
      current.executionState !== 'succeeded' ||
      current.healthState !== 'healthy' ||
      current.sourceState !== 'ready' ||
      !current.choices.destinationHandle
    ) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'meeting intake has not completed successfully');
    }
    try {
      const presentationRetry = await this.options.dispatcher.retryPresentation({ intake: current, clientRequestId });
      return { intake: current, presentationRetry };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      throw new MeetingIntakeError(
        code === 'ROUTE_UNAVAILABLE' ? 'DESTINATION_UNAVAILABLE' : 'EXECUTION_FAILED',
        code === 'ROUTE_UNAVAILABLE'
          ? 'meeting write-opportunity presentation is unavailable'
          : 'meeting write-opportunity presentation retry failed',
      );
    }
  }

  async markSourceDeleted(ownerId: string, intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.requireOwner(ownerId, intakeId, expectedRevision);
    return this.fail(current, 'source_deleted');
  }

  async manualImport(
    ownerId: string,
    intakeId: string,
    expectedRevision: number,
    sourceHandle: string,
  ): Promise<MeetingIntake> {
    const current = await this.requireOwner(ownerId, intakeId, expectedRevision);
    if (
      current.repair?.action !== 'manual_import' ||
      current.judgmentState !== 'confirmed' ||
      current.executionState !== 'failed' ||
      !sourceHandle.startsWith('feishu://meeting-artifacts/') ||
      !this.options.sources.supports(sourceHandle)
    ) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'manual meeting source reference is unavailable or invalid');
    }
    const rebound = await this.write(current, {
      ...current,
      source: { handle: sourceHandle },
      artifact: undefined,
      sourceState: 'ready',
      executionState: 'queued',
      repair: undefined,
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
    return this.executeFromSource(ownerId, intakeId, rebound.revision);
  }

  private async executeFromSource(ownerId: string, intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.requireOwner(ownerId, intakeId, expectedRevision);
    const running = await this.start(current);
    let resolved: ResolvedMeetingArtifact;
    try {
      const principalId = `meeting-intake:${running.intakeId}`;
      const lease = await this.options.sources.issue({
        intakeId: running.intakeId,
        principalId,
        purpose: 'transcript',
      });
      resolved = await this.options.sources.resolve(
        { intakeId: running.intakeId, principalId, purpose: 'transcript', grant: lease.grant },
        new AbortController().signal,
      );
    } catch (error) {
      return this.fail(running, sourceFailure(error));
    }
    const artifact = createMeetingArtifactDescriptor({
      intakeId: running.intakeId,
      sourceHandle: resolved.provenance.sourceHandle,
      contentType: resolved.contentType,
      text: resolved.text,
    });
    const bound = await this.write(running, {
      ...running,
      artifact,
      revision: running.revision + 1,
      updatedAt: this.now(),
    });
    return this.finish(bound, async () => this.options.dispatcher.deliver({ intake: bound, artifact }));
  }

  private async start(current: MeetingIntake): Promise<MeetingIntake> {
    if (
      current.judgmentState !== 'confirmed' ||
      (current.executionState !== 'queued' && current.executionState !== 'failed') ||
      !current.choices.destinationHandle
    ) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'meeting choices must be confirmed before execution');
    }
    return this.write(current, {
      ...current,
      executionState: 'running',
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  private async finish(current: MeetingIntake, deliver: () => Promise<void>): Promise<MeetingIntake> {
    try {
      await deliver();
    } catch (error) {
      return this.fail(current, dispatchFailure(error));
    }
    return this.write(current, {
      ...current,
      sourceState: 'ready',
      executionState: 'succeeded',
      healthState: 'healthy',
      repair: undefined,
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  private async fail(current: MeetingIntake, code: ActionFailure): Promise<MeetingIntake> {
    const repair = REPAIR_BY_CODE[code];
    return this.write(current, {
      ...current,
      ...(repair.sourceState ? { sourceState: repair.sourceState } : {}),
      executionState: 'failed',
      healthState: 'degraded',
      repair: { code, action: repair.action, observedAt: this.now() },
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  private async requireOwner(ownerId: string, intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.options.store.get(intakeId);
    if (!current || current.ownerId !== ownerId) {
      throw new MeetingIntakeError('INTAKE_NOT_FOUND', 'meeting intake not found');
    }
    if (current.revision !== expectedRevision) {
      throw new MeetingIntakeError(
        'REVISION_CONFLICT',
        `expected revision ${expectedRevision}, current ${current.revision}`,
      );
    }
    return current;
  }

  private async write(current: MeetingIntake, next: MeetingIntake): Promise<MeetingIntake> {
    const result = await this.options.store.compareAndSet(current.intakeId, current.revision, next);
    if (result.outcome === 'missing') throw new MeetingIntakeError('INTAKE_NOT_FOUND', 'meeting intake not found');
    if (result.outcome === 'revision_conflict') {
      throw new MeetingIntakeError('REVISION_CONFLICT', 'meeting intake changed concurrently');
    }
    return result.intake;
  }
}
