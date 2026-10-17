import {
  assertCustodyContract,
  type PredicateCompletionInput,
  type PredicateCompletionResult,
  type PredicateFreshnessInput,
  type PredicateFreshnessResult,
  type PredicateProviderBinding,
} from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { withoutPluginCallContext } from './plugin-call-context.js';
import { snapshotPluginProtocolData as snapshot } from './plugin-protocol-data.js';
import { withPluginTransportPurpose } from './plugin-transport-context.js';

interface PredicateVerifierContextBase {
  readonly tenantScope: string;
  readonly installationProjectRoot: string;
  readonly binding: PredicateProviderBinding;
  readonly assignment: { readonly holderCatIds: readonly string[]; readonly holderThreadId: string };
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
interface PredicatePrincipal {
  readonly catId: string;
  readonly threadId: string;
  readonly userId: string;
}
export type PredicateVerifierContext = PredicateVerifierContextBase &
  (
    | { readonly phase: 'freshness'; readonly principal: PredicatePrincipal }
    | { readonly phase: 'completion'; readonly principal: PredicatePrincipal & { readonly invocationId: string } }
  );
export interface PredicateVerifierPort {
  invokePredicateVerifier(
    instanceId: string,
    method: string,
    input: PredicateFreshnessInput | PredicateCompletionInput,
    context: PredicateVerifierContext,
  ): Promise<PredicateFreshnessResult | PredicateCompletionResult>;
}
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** Called only by the private carrier purpose. Inventory/lease authority remains with the dispatcher. */
export async function invokeIsolatedPredicateVerifier(
  instanceId: string,
  method: string,
  phase: 'freshness' | 'completion',
  handler: (input: unknown, context: unknown) => unknown,
  input: PredicateFreshnessInput | PredicateCompletionInput,
  context: PredicateVerifierContext,
  assertActivation: () => void,
): Promise<PredicateFreshnessResult | PredicateCompletionResult> {
  if (context.phase !== phase || !(context.signal instanceof AbortSignal)) refuse('Invalid verifier phase or signal');
  const binding = snapshot(context.binding);
  assertCustodyContract('PredicateProviderBinding', binding);
  if (
    binding.pluginInstanceId !== instanceId ||
    binding.tenantScope !== context.tenantScope ||
    binding.installationProjectRoot !== context.installationProjectRoot ||
    method !== (phase === 'freshness' ? binding.freshnessMethod : binding.completionMethod)
  ) {
    refuse('Predicate verifier binding mismatch');
  }
  const { catId, threadId, userId } = context.principal;
  if (![catId, threadId, userId].every(nonempty) || userId !== binding.tenantScope)
    refuse('Invalid verifier principal');
  let principal: PredicateVerifierContext['principal'];
  if (context.phase === 'completion') {
    if (!nonempty(context.principal.invocationId)) refuse('Completion requires a current native invocation');
    principal = Object.freeze({ catId, threadId, userId, invocationId: context.principal.invocationId });
  } else principal = Object.freeze({ catId, threadId, userId });
  const assignment = snapshot({
    holderCatIds: context.assignment.holderCatIds,
    holderThreadId: context.assignment.holderThreadId,
  }) as PredicateVerifierContext['assignment'];
  if (
    !nonempty(assignment.holderThreadId) ||
    !Array.isArray(assignment.holderCatIds) ||
    assignment.holderCatIds.length === 0 ||
    !assignment.holderCatIds.every(nonempty)
  )
    refuse('Invalid verifier assignment');
  if (phase === 'completion' && (!assignment.holderCatIds.includes(catId) || assignment.holderThreadId !== threadId))
    refuse('Completion caller does not hold the frozen assignment');
  const request = snapshot(input);
  if (phase === 'freshness') assertCustodyContract('PredicateFreshnessInput', request);
  else assertCustodyContract('PredicateCompletionInput', request);
  const frozenInput = request as PredicateFreshnessInput | PredicateCompletionInput;
  if (frozenInput.subjectRef !== frozenInput.predicate.subjectRef) refuse('Predicate subject mismatch');
  const signal = context.signal;
  const checkAuthority = context.assertCurrent;
  if (typeof checkAuthority !== 'function') refuse('Verifier authority fence missing');
  let finished = false;
  const assertCurrent = async () => {
    if (finished || signal.aborted) refuse('Predicate invocation expired');
    assertActivation();
    await checkAuthority();
    if (finished || signal.aborted) refuse('Predicate invocation expired');
    assertActivation();
  };
  const isolated = Object.freeze({
    phase,
    tenantScope: binding.tenantScope,
    installationProjectRoot: binding.installationProjectRoot,
    binding,
    assignment,
    principal,
    signal,
    assertCurrent,
  });
  let removeAbortListener = () => {};
  try {
    await assertCurrent();
    // Suppress ALL native plugin call contexts, including another instance's outer invocation.
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Predicate invocation cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    const raw = await Promise.race([
      withoutPluginCallContext(async () => {
        signal.throwIfAborted();
        assertActivation();
        return withPluginTransportPurpose('verifier', async () => handler(frozenInput, isolated));
      }),
      aborted,
    ]);
    await assertCurrent();
    const result = snapshot(raw);
    if (phase === 'freshness') {
      assertCustodyContract('PredicateFreshnessResult', result);
      if (
        result.status === 'verified' &&
        (result.freshnessKey !== frozenInput.predicate.freshnessKey ||
          !assignment.holderCatIds.includes(result.ownerCatId) ||
          result.holderThreadId !== assignment.holderThreadId)
      ) {
        refuse('Freshness result does not match admitted assignment');
      }
      return result;
    }
    assertCustodyContract('PredicateCompletionResult', result);
    if (
      result.status === 'verified' &&
      (result.predicateDigest !== frozenInput.predicate.digest ||
        result.freshnessKey !== frozenInput.predicate.freshnessKey ||
        !('evidenceRefs' in frozenInput) ||
        !frozenInput.evidenceRefs.includes(result.evidenceRef))
    ) {
      refuse('Completion result does not match frozen candidate');
    }
    return result;
  } finally {
    finished = true;
    removeAbortListener();
  }
}
