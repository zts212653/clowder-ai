import { isDeepStrictEqual } from 'node:util';
import { type CollectiveConnector, ConnectorTransportError } from '@cat-cafe/collective-connector';
import type { CollectiveSourceIdentity } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { collectiveContextError } from '../collective-context-refs.js';
import { CollectiveReconsiderationRefusalError } from './collective-reconsideration-refusal.js';

export const collectiveReconsiderationMarkerSchema = z
  .object({
    sourceMessageId: z.string().min(1).max(240),
    grantRef: z.string().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().min(1).max(240),
    purposeKey: z.string().regex(/^collective-reconsider:[a-f0-9]{64}$/),
  })
  .strict();
export type ReconsiderationPurpose = Pick<
  z.infer<typeof collectiveReconsiderationMarkerSchema>,
  'grantRef' | 'grantRevision' | 'requestKind'
>;
const permanentCodes = new Set([
  'WORK_DELEGATION_UNAVAILABLE',
  'WORK_OWNER_DECISION_REQUIRED',
  'PARTICIPATION_REVOKED',
  'CONNECTION_REVOKED',
  'CONNECTOR_OWNER_MISMATCH',
  'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE',
]);

/** A g1 wake cannot borrow g2 policy after restart, before the model starts, or on a later callback. */
export async function requireCurrentReconsiderationSource(input: {
  connector: CollectiveConnector;
  messages: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByIdempotencyKey'>>;
  message: StoredMessage;
  source: CollectiveSourceIdentity;
  ownerUserId: string;
}) {
  const unsafe = input.message.source?.meta?.reconsideration;
  if (unsafe === undefined) return;
  const marker = collectiveReconsiderationMarkerSchema.safeParse(unsafe);
  if (
    !marker.success ||
    input.message.source?.connector !== 'collective' ||
    input.message.catId !== null ||
    input.message.userId !== input.ownerUserId ||
    input.message.queueCustody?.executionScope !== 'collective-participation' ||
    input.message.queueCustody.ownerAuthProvenance !== 'unknown' ||
    input.message.queueCustody.allTargetCats.length !== 1 ||
    input.message.queueCustody.allTargetCats[0] !== input.source.catId
  )
    throw collectiveContextError('RETURN_UNAVAILABLE', 'The reconsideration carrier has no exact Host producer schema');
  const winner = await input.messages.getByIdempotencyKey?.(
    input.ownerUserId,
    input.message.threadId,
    marker.data.purposeKey,
  );
  if (winner?.id !== input.message.id)
    throw collectiveContextError('RETURN_UNAVAILABLE', 'The reconsideration carrier has no durable purpose index');
  try {
    await input.connector.withWorkReconsiderationAuthority(
      input.source.connectionId,
      input.ownerUserId,
      {
        sourceEventId: input.source.eventId,
        catId: input.source.catId,
        grantRef: marker.data.grantRef,
        grantRevision: marker.data.grantRevision,
        requestKind: marker.data.requestKind,
      },
      async (scope) => {
        const original = await input.messages.getById(scope.sourceMessageId);
        if (
          scope.sourceMessageId !== marker.data.sourceMessageId ||
          scope.threadId !== input.message.threadId ||
          scope.purposeKey !== marker.data.purposeKey ||
          !isDeepStrictEqual(scope.source, input.source) ||
          input.message.content !== scope.event.body ||
          input.message.queueCustody?.executionScope !== 'collective-participation' ||
          input.message.queueCustody.ownerAuthProvenance !== 'unknown' ||
          !original ||
          original.deletedAt ||
          original.recall ||
          original._tombstone ||
          original.userId !== input.ownerUserId
        )
          throw new CollectiveReconsiderationRefusalError(
            input.message.id,
            marker.data.purposeKey,
            'purpose_not_current',
          );
        await scope.assertCurrentPermission();
      },
    );
  } catch (error) {
    const code =
      error instanceof ConnectorTransportError
        ? error.causeCode
        : error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
    if (typeof code === 'string' && permanentCodes.has(code))
      throw new CollectiveReconsiderationRefusalError(
        input.message.id,
        marker.data.purposeKey,
        'permission_not_current',
        error,
      );
    throw error;
  }
  const { grantRef, grantRevision, requestKind } = marker.data;
  return { grantRef, grantRevision, requestKind };
}

/** Public decision cards expose only the actual owner wake's selected rule and class. */
export async function ownerWakeDecision(
  connector: CollectiveConnector,
  binding: { source: CollectiveSourceIdentity; ownerWakePurpose?: ReconsiderationPurpose },
) {
  const decision = await connector.currentWorkDecision(binding.source);
  const purpose = binding.ownerWakePurpose;
  if (!purpose) return decision;
  return {
    ...decision,
    grants: decision.grants
      .filter(
        (grant) =>
          grant.grantRef === purpose.grantRef &&
          grant.grantRevision === purpose.grantRevision &&
          grant.requestKinds.includes(purpose.requestKind),
      )
      .map((grant) => ({ ...grant, requestKinds: [purpose.requestKind] })),
  };
}

/** Wrong callback arguments are correctable tool errors, not a permanent pre-provider wake refusal. */
export function assertReconsiderationInput(
  purpose: ReconsiderationPurpose | undefined,
  input: { grantRef: string; grantRevision: number; requestKind: string },
) {
  if (
    purpose &&
    (input.grantRef !== purpose.grantRef ||
      input.grantRevision !== purpose.grantRevision ||
      input.requestKind !== purpose.requestKind)
  )
    throw collectiveContextError(
      'WORK_AUTHORITY_REQUIRED',
      'Use the exact current rule and class selected by this owner wake',
    );
}
