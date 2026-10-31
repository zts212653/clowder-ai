import type { TranscriptEvent } from '../TranscriptReader.js';

/** Resolver presence and generation integrity need no unrelated text/tool bodies across process IPC.
 * Keep every generation-prefixed event intact, including malformed/unknown kinds: their identity
 * and validation still belong to RequestGenerationProjector and the source permission policy.
 */
export function projectRequestGenerationEvidence(event: TranscriptEvent): TranscriptEvent {
  return String(event.event.type).startsWith('request_generation_')
    ? event
    : { ...event, event: { type: event.event.type } };
}
