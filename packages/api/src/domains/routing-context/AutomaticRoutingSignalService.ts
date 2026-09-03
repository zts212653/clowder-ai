import { createHash } from 'node:crypto';
import { type RoutingSignalEventV1, routingSignalEventV1Schema } from '@cat-cafe/shared';
import type { IRoutingSignalEventStore, RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import {
  type AutomaticRoutingSignalAssertionInput,
  type AutomaticRoutingSignalRecoveryInput,
  automaticRoutingSignalAssertionInputSchema,
  automaticRoutingSignalRecoveryInputSchema,
} from './RoutingSignalObservation.js';

export type AutomaticRoutingSignalErrorCode = 'not_found' | 'scope_mismatch' | 'source_mismatch';

export class AutomaticRoutingSignalError extends Error {
  constructor(
    readonly code: AutomaticRoutingSignalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomaticRoutingSignalError';
  }
}

export interface AutomaticRoutingSignalServiceOptions {
  signalStore: Pick<IRoutingSignalEventStore, 'append' | 'get'>;
}

function stableId(prefix: string, kind: string, ownerId: string, observationId: string): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(ownerId)
    .update('\0')
    .update(observationId)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function subjectIdentity(subject: AutomaticRoutingSignalAssertionInput['subjectRef']): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

export class AutomaticRoutingSignalService {
  constructor(private readonly options: AutomaticRoutingSignalServiceOptions) {}

  async assert(inputValue: AutomaticRoutingSignalAssertionInput): Promise<RoutingSignalEventAppendResult> {
    const input = automaticRoutingSignalAssertionInputSchema.parse(inputValue);
    const event = routingSignalEventV1Schema.parse({
      v: 1,
      eventId: stableId('routing-signal', 'assert', input.ownerId, input.observationId),
      commandId: stableId('routing-observation', 'assert', input.ownerId, input.observationId),
      ownerId: input.ownerId,
      subjectRef: input.subjectRef,
      reasonCode: input.reasonCode,
      ...(input.note !== undefined ? { note: input.note } : {}),
      source: input.source,
      observedAt: input.observedAt,
      evidenceRef: input.evidenceRef,
      eventType: 'asserted',
      state: input.state,
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
    });
    return this.options.signalStore.append(event);
  }

  async recover(inputValue: AutomaticRoutingSignalRecoveryInput): Promise<RoutingSignalEventAppendResult> {
    const input = automaticRoutingSignalRecoveryInputSchema.parse(inputValue);
    const assertions = await Promise.all(
      input.closesSignalIds.map((eventId) => this.options.signalStore.get(input.ownerId, eventId)),
    );
    for (const [index, assertion] of assertions.entries()) {
      const eventId = input.closesSignalIds[index];
      if (assertion === null || assertion.eventType !== 'asserted') {
        throw new AutomaticRoutingSignalError('not_found', `automatic routing assertion not found: ${eventId}`);
      }
      if (subjectIdentity(assertion.subjectRef) !== subjectIdentity(input.subjectRef)) {
        throw new AutomaticRoutingSignalError(
          'scope_mismatch',
          `automatic routing assertion scope mismatch: ${eventId}`,
        );
      }
      if (!new Set<string>(input.recoverableSources).has(assertion.source)) {
        throw new AutomaticRoutingSignalError(
          'source_mismatch',
          `automatic routing assertion source mismatch: ${eventId}`,
        );
      }
    }

    const event: RoutingSignalEventV1 = routingSignalEventV1Schema.parse({
      v: 1,
      eventId: stableId('routing-signal', 'recover', input.ownerId, input.observationId),
      commandId: stableId('routing-observation', 'recover', input.ownerId, input.observationId),
      ownerId: input.ownerId,
      subjectRef: input.subjectRef,
      reasonCode: input.reasonCode,
      ...(input.note !== undefined ? { note: input.note } : {}),
      source: input.source,
      observedAt: input.observedAt,
      evidenceRef: input.evidenceRef,
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: input.closesSignalIds,
    });
    return this.options.signalStore.append(event);
  }
}
