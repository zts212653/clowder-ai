import type { EvalRepairOwnerRuntimeRegistration } from '../../harness-eval/eval-repair-owner-runtime.js';
import {
  createMicroduckEvalRepairOwnerBindingProvider,
  type MicroduckEvalRepairOwnerProviderOptions,
} from './microduck-eval-repair-owner-provider.js';

interface OwnerRuntimeRegistrationPort {
  registerBindingProvider: EvalRepairOwnerRuntimeRegistration['registerBindingProvider'];
}

export interface MicroduckEvalRepairOwnerRuntimeRegistrationOptions extends MicroduckEvalRepairOwnerProviderOptions {
  registration: OwnerRuntimeRegistrationPort;
}

/**
 * Adds Microduck to the canonical F266/F246/F313 owner federation. The existing F311 consumer and
 * outcome consumer remain singletons; this module registers neither and stores no lifecycle truth.
 */
export function registerMicroduckEvalRepairOwnerRuntime(
  options: MicroduckEvalRepairOwnerRuntimeRegistrationOptions,
): void {
  options.registration.registerBindingProvider(
    createMicroduckEvalRepairOwnerBindingProvider({
      ownerUserId: options.ownerUserId,
      programReader: options.programReader,
      invocationRegistry: options.invocationRegistry,
      adapter: options.adapter,
      ...(options.lineageBindingResolver ? { lineageBindingResolver: options.lineageBindingResolver } : {}),
      ...(options.ownerChangeContractResolver
        ? { ownerChangeContractResolver: options.ownerChangeContractResolver }
        : {}),
      ...(options.canonicalRepairDispatcher ? { canonicalRepairDispatcher: options.canonicalRepairDispatcher } : {}),
      ...(options.interventionReceiptOwner ? { interventionReceiptOwner: options.interventionReceiptOwner } : {}),
      ...(options.freshOutcomeOwner ? { freshOutcomeOwner: options.freshOutcomeOwner } : {}),
      ...(options.decisionOwner ? { decisionOwner: options.decisionOwner } : {}),
    }),
  );
}
