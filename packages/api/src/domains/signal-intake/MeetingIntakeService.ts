import type { MeetingIntake, MeetingIntakeChoices, MeetingIntakeRepair } from '@cat-cafe/shared';
import type { DestinationAuthority } from './DestinationAuthority.js';
import { MeetingIntakeError } from './errors.js';
import type { MeetingIntakeStore } from './MeetingIntakeStore.js';

export interface MeetingIntakeServiceOptions {
  readonly now?: () => number;
}

type RepairCode = MeetingIntakeRepair['code'];

const REPAIRS: Readonly<Record<RepairCode, Pick<MeetingIntakeRepair, 'action'>>> = {
  transcript_not_ready: { action: 'retry' },
  auth_required: { action: 'regrant' },
  source_deleted: { action: 'manual_import' },
  route_unavailable: { action: 'retry' },
  execution_failed: { action: 'retry' },
};

const OUTPUTS = new Set(['minutes', 'decisions', 'roadmap', 'tasks']);

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export class MeetingIntakeService {
  private readonly now: () => number;

  constructor(
    private readonly store: MeetingIntakeStore,
    private readonly destinations: DestinationAuthority,
    options: MeetingIntakeServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async confirm(intakeId: string, expectedRevision: number, choices: MeetingIntakeChoices): Promise<MeetingIntake> {
    const current = await this.requireRevision(intakeId, expectedRevision);
    if (current.judgmentState !== 'unresolved') {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'only an unresolved intake can be confirmed');
    }
    await this.validateChoices(current.ownerId, choices);
    return this.write(current, {
      ...current,
      judgmentState: 'confirmed',
      executionState: 'queued',
      unresolved: [],
      choices: structuredClone(choices),
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  async dismiss(intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.requireRevision(intakeId, expectedRevision);
    if (current.judgmentState === 'dismissed') {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'meeting intake is already dismissed');
    }
    if (current.executionState === 'running' || current.executionState === 'succeeded') {
      throw new MeetingIntakeError(
        'INVALID_TRANSITION',
        'an executing or completed meeting intake cannot be dismissed',
      );
    }
    const terminal = { ...current };
    delete (terminal as { repair?: MeetingIntakeRepair }).repair;
    return this.write(current, {
      ...terminal,
      judgmentState: 'dismissed',
      executionState: 'idle',
      healthState: 'healthy',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  async markRepair(
    intakeId: string,
    expectedRevision: number,
    input: { readonly code: RepairCode; readonly safeDetail?: string },
  ): Promise<MeetingIntake> {
    const current = await this.requireRevision(intakeId, expectedRevision);
    if (current.judgmentState === 'dismissed' || current.executionState === 'succeeded') {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'terminal meeting intake truth cannot be degraded');
    }
    if (!Object.hasOwn(REPAIRS, input.code)) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'repair code is not supported');
    }
    if (
      input.safeDetail !== undefined &&
      (!boundedText(input.safeDetail, 512) || containsControlCharacter(input.safeDetail))
    ) {
      throw new MeetingIntakeError('INVALID_TRANSITION', 'repair detail must be bounded redacted text');
    }
    const sourceState =
      input.code === 'transcript_not_ready'
        ? 'not_ready'
        : input.code === 'auth_required'
          ? 'auth_required'
          : input.code === 'source_deleted'
            ? 'deleted'
            : current.sourceState;
    return this.write(current, {
      ...current,
      sourceState,
      executionState:
        current.judgmentState === 'confirmed' || current.judgmentState === 'auto_resolved'
          ? 'failed'
          : current.executionState,
      healthState: 'degraded',
      repair: {
        code: input.code,
        action: REPAIRS[input.code].action,
        observedAt: this.now(),
        ...(input.safeDetail === undefined ? {} : { safeDetail: input.safeDetail }),
      },
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  async clearRepair(intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.requireRevision(intakeId, expectedRevision);
    if (!current.repair) throw new MeetingIntakeError('INVALID_TRANSITION', 'meeting intake has no repair state');
    const next = { ...current };
    delete (next as { repair?: MeetingIntakeRepair }).repair;
    return this.write(current, {
      ...next,
      sourceState: 'ready',
      healthState: 'healthy',
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
  }

  private async requireRevision(intakeId: string, expectedRevision: number): Promise<MeetingIntake> {
    const current = await this.store.get(intakeId);
    if (!current) throw new MeetingIntakeError('INTAKE_NOT_FOUND', `unknown meeting intake ${intakeId}`);
    if (current.revision !== expectedRevision) {
      throw new MeetingIntakeError(
        'REVISION_CONFLICT',
        `expected revision ${expectedRevision}, current ${current.revision}`,
      );
    }
    return current;
  }

  private async validateChoices(ownerId: string, choices: MeetingIntakeChoices): Promise<void> {
    if (
      !choices.speakerMap ||
      Object.keys(choices.speakerMap).length === 0 ||
      Object.entries(choices.speakerMap).some(([key, value]) => !boundedText(key, 128) || !boundedText(value, 256)) ||
      !boundedText(choices.context, 8_000) ||
      !boundedText(choices.destinationHandle, 512) ||
      !choices.outputs ||
      choices.outputs.length === 0 ||
      new Set(choices.outputs).size !== choices.outputs.length ||
      choices.outputs.some((output) => !OUTPUTS.has(output))
    ) {
      throw new MeetingIntakeError('INVALID_CHOICES', 'all unresolved meeting choices must be confirmed');
    }
    const destination = await this.destinations.resolve(choices.destinationHandle, ownerId);
    if (!destination || destination.kind !== 'private-thread') {
      throw new MeetingIntakeError(
        'DESTINATION_UNAVAILABLE',
        choices.destinationHandle.startsWith('host:channel:')
          ? 'F290 Channel destinations are not available'
          : 'destination is not an authorized private thread',
      );
    }
  }

  private async write(current: MeetingIntake, next: MeetingIntake): Promise<MeetingIntake> {
    const result = await this.store.compareAndSet(current.intakeId, current.revision, next);
    if (result.outcome === 'missing') throw new MeetingIntakeError('INTAKE_NOT_FOUND', 'meeting intake disappeared');
    if (result.outcome === 'revision_conflict') {
      throw new MeetingIntakeError('REVISION_CONFLICT', 'meeting intake changed concurrently');
    }
    return result.intake;
  }
}
