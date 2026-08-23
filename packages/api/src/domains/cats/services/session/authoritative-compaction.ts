import type { SessionRecord } from '@cat-cafe/shared';
import type { AgentContextCapability } from '../types.js';
import type { AuthoritativeCompactionEvent } from './ContextEpochOwner.js';

export type AuthoritativeCompactionEventSource =
  | 'claude_compact_boundary'
  | 'claude_precompact_hook'
  /**
   * F296 B4b: a `contextCompaction` thread item observed on the Codex
   * app-server wire. Admitted only because Gate 0 (2026-08-20, codex-cli
   * 0.147.0) dynamically observed the item, its `(threadId, turnId, item.id)`
   * envelope coordinates, and a consumable window before the next `turn/start`.
   */
  | 'codex_app_server_context_compaction';

export type AuthoritativeCompactionSupport =
  | { readonly status: 'supported'; readonly eventSource: AuthoritativeCompactionEventSource }
  | {
      readonly status: 'unsupported';
      readonly reason: 'typed_event_unroutable' | 'carrier_event_delivery_unproven';
    };

/**
 * A capability declaration is not an event route. A carrier earns epoch
 * authority by having its event delivery dynamically proven end to end, never
 * by declaring `observesCompression=true` or by appearing in a schema enum.
 *
 * Two carriers currently qualify: the Claude print carrier (typed boundary +
 * authenticated project hook) and the Codex app-server (F296 B4 Gate 0).
 */
export function resolveAuthoritativeCompactionSupport(input: {
  readonly capability: AgentContextCapability;
  readonly eventSource: AuthoritativeCompactionEventSource;
}): AuthoritativeCompactionSupport {
  const { capability, eventSource } = input;
  if (capability.provider === 'anthropic' && capability.carrier === 'print_sdk') {
    return { status: 'supported', eventSource };
  }
  // The app-server source is bound to the app-server carrier. A Codex
  // exec_json invocation can never route this event, and no other event source
  // can borrow the app-server's proof.
  if (eventSource === 'codex_app_server_context_compaction') {
    return capability.provider === 'openai' && capability.carrier === 'app_server'
      ? { status: 'supported', eventSource }
      : { status: 'unsupported', reason: 'typed_event_unroutable' };
  }
  if (
    eventSource === 'claude_precompact_hook' &&
    capability.provider === 'anthropic' &&
    (capability.carrier === 'bg' || capability.carrier === 'interactive_pty')
  ) {
    return { status: 'unsupported', reason: 'carrier_event_delivery_unproven' };
  }
  return { status: 'unsupported', reason: 'typed_event_unroutable' };
}

/**
 * The hook increments SessionRecord compression telemetry before the provider
 * emits `compact_boundary`, so both paths derive the same event id. That makes
 * hook + stream delivery a replay of one event rather than two epoch advances.
 */
export function authoritativeCompactionEventFromSession(
  record: Pick<SessionRecord, 'id' | 'cliSessionId' | 'compressionCount' | 'hybridProgress'>,
  eventSource: AuthoritativeCompactionEventSource,
): AuthoritativeCompactionEvent {
  const sequence = record.compressionCount ?? record.hybridProgress?.observedCount;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`authoritative_compaction_sequence_unavailable:${record.id}`);
  }
  if (!record.cliSessionId) {
    throw new Error(`authoritative_compaction_runtime_unavailable:${record.id}`);
  }
  return {
    eventId: `context-compaction:${record.id}:${sequence}`,
    runtimeSessionId: record.cliSessionId,
    evidenceRef: `${eventSource}:${record.id}:${sequence}`,
  };
}
