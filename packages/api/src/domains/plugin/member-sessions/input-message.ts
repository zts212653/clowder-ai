import type { MessageDraft } from '@clowder-ai/plugin-contract';
import { validateDraft } from '../../messaging/contract/validate.js';

/** Validate the exact published message representation before acquiring a lease.
 * JSON escaping has a byte cost even when the original string is under 64 KiB. */
export function memberInputPayload(content: string): MessageDraft['payload'] {
  return validateDraft({
    address: { kind: 'thread_handle', handle: 'internal-validation' },
    idempotencyKey: 'member-input-validation',
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'member-input', kind: 'text', payload: { text: content } }],
    },
  }).payload;
}
