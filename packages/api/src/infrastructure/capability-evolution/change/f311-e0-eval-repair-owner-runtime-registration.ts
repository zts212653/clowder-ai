import type { EvalRepairEvolutionOwnerPort } from '../../harness-eval/eval-repair-evolution-owner-port.js';
import type { EvalRepairOutcomeService } from '../../harness-eval/eval-repair-outcome.js';
import type {
  EvalRepairOutcomeServiceConsumer,
  EvalRepairOwnerRuntimeRegistration,
} from '../../harness-eval/eval-repair-owner-runtime.js';
import {
  createF311E0EvalRepairOwnerBindingProvider,
  type F311E0EvalRepairOwnerProviderOptions,
} from './f311-e0-eval-repair-owner-provider.js';

interface OwnerRuntimeRegistrationPort {
  registerBindingProvider: EvalRepairOwnerRuntimeRegistration['registerBindingProvider'];
  registerEvolutionOwnerConsumer: EvalRepairOwnerRuntimeRegistration['registerEvolutionOwnerConsumer'];
  registerOutcomeServiceConsumer: EvalRepairOwnerRuntimeRegistration['registerOutcomeServiceConsumer'];
}

export interface F311E0EvalRepairOwnerRuntimeRegistrationOptions extends F311E0EvalRepairOwnerProviderOptions {
  registration: OwnerRuntimeRegistrationPort;
  connectEvolutionOwner(owner: EvalRepairEvolutionOwnerPort): void;
  connectOutcomeService(service: EvalRepairOutcomeService): void;
}

/**
 * The API and official Alpha bootstrap use this same composition seam. Registration is process-local
 * wiring only; createEvalRepairOwnerRuntime still requires the independent F266 v1_active epoch.
 */
export function registerF311E0EvalRepairOwnerRuntime(options: F311E0EvalRepairOwnerRuntimeRegistrationOptions): void {
  options.registration.registerBindingProvider(
    createF311E0EvalRepairOwnerBindingProvider({
      repoRoot: options.repoRoot,
      ownerUserId: options.ownerUserId,
      programReader: options.programReader,
      invocationRegistry: options.invocationRegistry,
    }),
  );
  options.registration.registerEvolutionOwnerConsumer({ connect: options.connectEvolutionOwner });
  const outcomeConsumer: EvalRepairOutcomeServiceConsumer = { connect: options.connectOutcomeService };
  options.registration.registerOutcomeServiceConsumer(outcomeConsumer);
}
