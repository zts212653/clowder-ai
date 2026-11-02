import type { PreparedProviderRequestV1 } from '../../types.js';
import { requireExactPreparedProviderMessage } from '../../types.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';
import {
  type CodexCapacityRecoveryAnchor,
  CodexCapacityRecoveryCheckpoint,
} from './CodexCapacityRecoveryCheckpoint.js';

export const CODEX_ACTIVE_WORK_CONTEXT_KEY = 'cat-cafe.active-work';
export const CODEX_ACTIVE_WORK_CONTEXT_DECISION = 'app_server_active_work_context';
export const CODEX_COMPACTION_CONTINUATION_TRIGGER =
  'The Host attached source-linked continuation context for the same accepted request. This is not a new user request.';

/**
 * Native new_context can retain AGENTS.md while moving every actual request
 * behind an unavailable history backend. Prepare a bounded, source-only cue
 * AFTER that boundary; initial turn application context is also discarded.
 * User text stays user input. Resolve the mutable anchor after preflight.
 */
export function codexActiveWorkContext(
  rawAnchor: CodexCapacityRecoveryAnchor | undefined,
): PreparedProviderRequestV1['nativeInstructions'][number] | undefined {
  const anchor = new CodexCapacityRecoveryCheckpoint(rawAnchor).snapshot().anchor;
  if (!anchor?.promptMessageIds.length) return undefined;
  return Object.freeze({
    injectionDecision: CODEX_ACTIVE_WORK_CONTEXT_DECISION,
    sourceRefs: Object.freeze(
      anchor.promptMessageIds.map((id) =>
        Object.freeze({ owner: 'message' as const, ref: `${anchor.threadId}:${id}` }),
      ),
    ),
    body: [
      'This Host invocation already has a request. It may be a conversation, review, or implementation task.',
      'After a native context-window change, recover that exact request and its latest progress before responding.',
      'Use the available Clowder AI thread-context tools with the coordinates below; native history/notes may be unavailable.',
      'Verify current state and completed side effects before repeating work. Preserve the original scope and authorization.',
      'AGENTS.md/environment setup alone is not the current request. Do not ask for a new task merely because those are all the new window shows.',
      'These coordinates grant no new authority and never override cancellation, later user instructions, or an already completed request.',
      JSON.stringify(anchor),
    ].join('\n'),
  });
}

/** A context-only follow-up must not redeliver old presentation/nudge bodies. */
export function isCodexCompactionContinuation(request: PreparedProviderRequestV1): boolean {
  return (
    request.runtime.provider === 'openai' &&
    request.runtime.carrier === 'app_server' &&
    request.boundaryReason === 'provider_continuation' &&
    'body' in request.message &&
    request.message.body === CODEX_COMPACTION_CONTINUATION_TRIGGER &&
    request.message.injectionDecision === CODEX_ACTIVE_WORK_CONTEXT_DECISION &&
    request.nativeInstructions.length === 1 &&
    request.nativeInstructions[0]?.injectionDecision === CODEX_ACTIVE_WORK_CONTEXT_DECISION &&
    Boolean(request.nativeInstructions[0].sourceRefs?.length)
  );
}

export async function continueCodexWorkAfterCompaction(input: {
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
  prepare: () => PreparedProviderRequestV1 | undefined;
  commit?: (request: PreparedProviderRequestV1) => Promise<unknown>;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const prepared = input.prepare();
  if (!prepared) return;
  if (!isCodexCompactionContinuation(prepared)) throw new Error('codex_compaction_context_not_exact');
  await input.commit?.(prepared);
  input.signal?.throwIfAborted();
  const result = asCodexAppServerRecord(
    await input.request('turn/steer', {
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      input: [{ type: 'text', text: requireExactPreparedProviderMessage(prepared) }],
      additionalContext: {
        [CODEX_ACTIVE_WORK_CONTEXT_KEY]: { kind: 'application', value: prepared.nativeInstructions[0].body },
      },
    }),
  );
  if (result?.turnId !== input.turnId) throw new Error('codex_compaction_continuation_turn_mismatch');
}
