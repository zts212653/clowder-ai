import { messageFrom } from '../../cats/services/stores/message-from.js';
import { isDelivered, type StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../../cats/services/stores/visibility.js';

/** Diagnose an already rejected message; never grant eligibility or export source material. */
export function ownerMessageRejectionReason(message: StoredMessage | null | undefined, owner: string): string {
  if (!message) return 'message_missing';
  if (message.userId !== owner) return 'message_owner_mismatch';
  if (messageFrom(message).kind !== 'user') return 'message_not_owner_authored';
  if (message.deletedAt !== undefined || message._tombstone === true) return 'message_deleted';
  if (!isDelivered(message)) return 'message_not_delivered';
  if (!canViewMessage(message, { type: 'user' })) return 'message_not_visible';
  return 'message_ineligible';
}

const CANONICAL_REASONS = new Set([
  'invalid_source_owner',
  'invalid_message_source',
  'invalid_attachment_source',
  'source_digest_mismatch',
  'source_excerpt_mismatch',
  'source_drift',
  'attachment_transcript_mismatch',
  'invalid_transcript_confirmation',
  'invalid_artifact_confirmation',
  'invalid_private_artifact',
]);

/** Keep canonical error strings outside this fixed vocabulary out of the log. */
export function canonicalSourceRejectionReason(error: string): string {
  return CANONICAL_REASONS.has(error) ? error : 'typed_provenance_invalid';
}
