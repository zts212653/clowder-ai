import { z } from 'zod';
import { type WatcherDecision, watcherDecisionSchema } from './run-case.js';

export const WATCHER_WIRE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['read', 'silent', 'hint'] },
    sourceIds: { type: 'array', items: { type: 'string' } },
    message: { type: ['string', 'null'] },
    basis: { type: ['string', 'null'] },
    recipient: { type: ['string', 'null'], enum: ['working_cat', 'owner_and_working_cat', null] },
    ownerReason: { type: ['string', 'null'], enum: ['before_asking_owner', 'spinning_in_place', 'goal_drift', null] },
  },
  required: ['kind', 'sourceIds', 'message', 'basis', 'recipient', 'ownerReason'],
  additionalProperties: false,
} as const;

const wireSchema = z
  .object({
    kind: z.enum(['read', 'silent', 'hint']),
    sourceIds: z.array(z.string()),
    message: z.string().nullable(),
    basis: z.string().nullable(),
    recipient: z.enum(['working_cat', 'owner_and_working_cat']).nullable(),
    ownerReason: z.enum(['before_asking_owner', 'spinning_in_place', 'goal_drift']).nullable(),
  })
  .strict();

/** Native structured output has one fixed shape; reject contradictory unused fields. */
export function decodeWatcherWire(input: unknown): WatcherDecision {
  const wire = wireSchema.parse(input);
  if (wire.kind !== 'hint' && (wire.recipient !== null || wire.ownerReason !== null))
    throw new Error('invalid_recipient_fields');
  if (wire.kind === 'read') {
    if (wire.message !== null || wire.basis !== null) throw new Error('invalid_read_fields');
    return watcherDecisionSchema.parse({ kind: 'read', sourceIds: wire.sourceIds });
  }
  if (wire.kind === 'silent') {
    if (wire.sourceIds.length || wire.message !== null || wire.basis !== null) throw new Error('invalid_silent_fields');
    return { kind: 'silent' };
  }
  if (wire.sourceIds.length !== 1) throw new Error('hint_requires_one_source');
  return watcherDecisionSchema.parse({
    kind: 'hint',
    sourceId: wire.sourceIds[0],
    message: wire.message,
    basis: wire.basis,
    recipient: wire.recipient,
    ownerReason: wire.ownerReason,
  });
}
