import { contextEpochScopeKey } from '../../../cats/services/session/context/ContextEpochOwner.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { LiveInboxScope } from '../inbox/live-inbox-contract.js';
import { LiveCarrierUnavailableError } from '../LiveCarrierOperationGate.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { LiveRecoveryReader } from '../recovery/LiveRecoveryReader.js';
import type { LiveContextGate } from './live-controlled-context.js';
import { LiveRecoveryHost, type LiveRecoverySnapshot } from './live-recovery-host.js';

function sameScope(left: LiveInboxScope, right: LiveInboxScope): boolean {
  return (
    left.userId === right.userId &&
    left.threadId === right.threadId &&
    left.catId === right.catId &&
    left.invocationId === right.invocationId &&
    left.parentInvocationId === right.parentInvocationId &&
    left.callId === right.callId &&
    left.generation === right.generation
  );
}

/** C1 supplies projections; the Host retains authority through the final native write. */
export function bindLiveRecoveryHost(input: {
  options: LiveCompanionCallOptions;
  context: LiveContextGate;
  callbackEnv: Record<string, string>;
  wakeNative(): void;
  isSameCallExposure(message: StoredMessage): boolean;
}): LiveRecoveryHost | undefined {
  const { recovery, inbox } = input.options;
  if (!recovery || !inbox) return undefined;
  const scope = input.context.boundScope({
    invocationId: input.callbackEnv.CAT_CAFE_INVOCATION_ID,
    catId: input.options.binding.catId,
    threadId: input.options.binding.threadId,
  });
  if (!scope) throw new LiveCarrierUnavailableError();
  const authorize = async (candidate: LiveInboxScope): Promise<boolean> =>
    sameScope(candidate, scope) && (await input.context.canRead(candidate)) && (await recovery.authorize(candidate));
  const source = inbox.source(scope, authorize, input.isSameCallExposure);
  const reader = new LiveRecoveryReader({ ...recovery, inbox: source, authorize });
  const validate = async (snapshot: LiveRecoverySnapshot, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || !sameScope(snapshot.scope, scope) || !(await authorize(scope))) return false;
    const epoch = await recovery.epochs.get(contextEpochScopeKey(scope));
    if (signal.aborted) return false;
    if (snapshot.continuity.source === 'unavailable') return epoch === null;
    return (
      epoch?.version === snapshot.continuity.recordVersion && epoch.contextEpoch === snapshot.continuity.contextEpoch
    );
  };
  return new LiveRecoveryHost({
    scope,
    reader,
    validate,
    canDeliver: () =>
      Boolean(input.context.scope({ invocationId: scope.invocationId, catId: scope.catId, threadId: scope.threadId })),
    wakeNative: input.wakeNative,
    deliver: async (payload) => {
      try {
        await input.context.inject({
          scope,
          kind: 'recovery_context',
          text: payload.text,
          sourceRefs: payload.sourceRefs,
          signal: payload.signal,
          authorizeSource: (signal) => validate(payload.snapshot, signal),
        });
        return 'accepted';
      } catch (error) {
        if (error instanceof LiveCarrierUnavailableError) return 'busy';
        throw error;
      }
    },
  });
}
