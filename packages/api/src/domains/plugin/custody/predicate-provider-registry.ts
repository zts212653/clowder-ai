import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCustodyContract, type CustodyCanonicalPredicate } from '@clowder-ai/plugin-contract';
import type { ActionFreshnessResolution } from '../../ball-custody/ActionSubjectTruthResolver.js';
import type { CanonicalActionTerminalPredicate } from '../../ball-custody/ActionTerminalPredicateCatalog.js';
import type {
  ActionCompletionAuthorization,
  ActionDispatchRecoveryAuthorization,
  ActionFreshnessContext,
  ActionPredicateProvider,
} from '../../ball-custody/action-predicate-authority.js';
import { bindActionCompletionVerdict } from '../../ball-custody/action-successor-completion-state-machine.js';
import type { ActionSuccessorLease } from '../../ball-custody/action-successor-state-machine.js';
import type { ActionTerminalProviderBinding } from '../../ball-custody/action-terminal-provider-binding.js';
import { currentPluginCallContext, type PluginCallContext } from '../carrier/plugin-call-context.js';
import type { PredicateVerifierContext, PredicateVerifierPort } from '../carrier/predicate-verifier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInventorySnapshot } from '../host-inventory/types.js';
import {
  assertPredicateProviderRunnable,
  authorizedPredicateProviders,
  type PredicateInstallationScope,
  refusePredicateAuthority,
} from './provider-selection.js';

/** One trusted owner/project inventory, not a plugin-selected registry or a tenant fallback. */
export class PluginPredicateProviderRegistry implements ActionPredicateProvider {
  readonly #scope: PredicateInstallationScope;
  constructor(
    private readonly inventory: PluginInventoryStore,
    private readonly verifier: PredicateVerifierPort,
    scope: PredicateInstallationScope,
    private readonly timeoutMs = 30_000,
  ) {
    if (!scope.tenantScope || scope.tenantScope.trim() !== scope.tenantScope || !scope.installationProjectRoot)
      throw new Error('Trusted predicate installation scope is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid predicate timeout');
    this.#scope = Object.freeze({ ...scope, installationProjectRoot: resolve(scope.installationProjectRoot) });
  }

  async resolveFreshness(
    predicate: CanonicalActionTerminalPredicate,
    input: ActionFreshnessContext,
  ): Promise<ActionFreshnessResolution> {
    if (input.tenantScope !== this.#scope.tenantScope || predicate.kind !== 'review_delivered')
      return { status: 'insufficient', reason: 'predicate installation scope unavailable' };
    const providers = authorizedPredicateProviders(await this.inventory.snapshot(), this.#scope);
    if (providers.length !== 1 || !providers[0])
      return {
        status: 'insufficient',
        reason: providers.length ? 'predicate provider selection is ambiguous' : 'predicate provider unavailable',
      };
    const provider = providers[0];
    assertPredicateProviderRunnable(provider);
    return this.readFreshness(predicate, input, provider.binding, AbortSignal.timeout(this.timeoutMs));
  }

  async authorizeDispatchRecovery(
    leaseInput: ActionSuccessorLease,
    context: ActionFreshnessContext,
  ): Promise<ActionDispatchRecoveryAuthorization> {
    const lease = structuredClone(leaseInput);
    const admitted = structuredClone(context);
    const binding = lease.terminalPredicateProviderBinding;
    const predicate = lease.terminalPredicate;
    if (
      !binding ||
      !predicate ||
      predicate.kind !== 'review_delivered' ||
      lease.actionFamily !== 'review' ||
      lease.tenantScope !== this.#scope.tenantScope ||
      admitted.tenantScope !== lease.tenantScope ||
      !lease.predecessorCatId ||
      admitted.actorCatId !== lease.predecessorCatId ||
      !lease.predecessorThreadId ||
      admitted.sourceThreadId !== lease.predecessorThreadId ||
      admitted.targetThreadId !== lease.holderThreadId ||
      !isDeepStrictEqual([...admitted.holderCatIds].sort(), [...lease.holderCatIds].sort())
    )
      return { status: 'insufficient', reason: 'bound recovery source unavailable' };
    const signal = AbortSignal.timeout(this.timeoutMs);
    await this.assertCurrent(binding, signal);
    return {
      status: 'authorized',
      withAuthority: (write) => this.withAuthority(binding, signal, write),
      resolveFreshness: () => this.readFreshness(predicate, admitted, binding, signal),
    };
  }

  private async readFreshness(
    predicate: CanonicalActionTerminalPredicate,
    input: ActionFreshnessContext,
    binding: ActionTerminalProviderBinding,
    signal: AbortSignal,
  ): Promise<ActionFreshnessResolution> {
    const canonical = this.canonical(predicate);
    const admitted = structuredClone(input);
    const assertCurrent = () => this.assertCurrent(binding, signal);
    const context: PredicateVerifierContext = {
      ...this.#scope,
      phase: 'freshness',
      binding,
      signal,
      assertCurrent,
      principal: { catId: admitted.actorCatId, threadId: admitted.sourceThreadId, userId: this.#scope.tenantScope },
      assignment: { holderCatIds: admitted.holderCatIds, holderThreadId: admitted.targetThreadId },
    };
    await assertCurrent();
    const result = await this.verifier.invokePredicateVerifier(
      binding.pluginInstanceId,
      binding.freshnessMethod,
      { actionFamily: 'review', subjectRef: canonical.subjectRef, predicate: canonical },
      context,
    );
    await assertCurrent();
    assertCustodyContract('PredicateFreshnessResult', result);
    if (result.status !== 'verified') {
      if (result.status === 'insufficient') return { status: 'insufficient', reason: result.reason };
      return {
        status: 'mismatch',
        reason: result.reason,
        evidenceRef: `verdict:${binding.pluginInstanceId}:${binding.contributionId}:mismatch`,
      };
    }
    if (
      result.freshnessKey !== canonical.freshnessKey ||
      !admitted.holderCatIds.includes(result.ownerCatId) ||
      result.holderThreadId !== admitted.targetThreadId
    )
      refusePredicateAuthority('Freshness result changed the admitted assignment');
    return {
      ...result,
      tenantScope: this.#scope.tenantScope,
      providerAuthority: { binding, withAuthority: (write) => this.withAuthority(binding, signal, write) },
    };
  }

  async authorizeCompletion(
    leaseInput: ActionSuccessorLease,
    actor: { catId: string },
  ): Promise<ActionCompletionAuthorization> {
    const lease = structuredClone(leaseInput);
    const binding = lease.terminalPredicateProviderBinding;
    if (
      !binding ||
      !lease.terminalPredicate ||
      lease.terminalPredicate.kind !== 'review_delivered' ||
      lease.tenantScope !== this.#scope.tenantScope
    )
      return { status: 'insufficient', reason: 'frozen predicate provider binding unavailable' };
    const caller = currentPluginCallContext(binding.pluginInstanceId);
    if (
      !caller?.assertInvocationCurrent ||
      caller.catId !== actor.catId ||
      caller.userId !== this.#scope.tenantScope ||
      caller.threadId !== lease.holderThreadId ||
      !lease.holderCatIds.includes(caller.catId) ||
      !caller.invocationId
    )
      return { status: 'insufficient', reason: 'current bound native invocation unavailable' };
    const signal = AbortSignal.timeout(this.timeoutMs);
    const assertCurrent = () => this.assertCurrent(binding, signal, caller);
    await assertCurrent();
    return {
      status: 'authorized',
      withAuthority: (write) => this.withAuthority(binding, signal, write, caller),
      resolveCompletion: async (predicate, candidateInput) => {
        if (!isDeepStrictEqual(predicate, lease.terminalPredicate))
          refusePredicateAuthority('Frozen predicate changed');
        const canonical = this.canonical(predicate);
        const candidate = structuredClone(candidateInput);
        const context: PredicateVerifierContext = {
          ...this.#scope,
          phase: 'completion',
          binding,
          signal,
          assertCurrent,
          principal: {
            catId: caller.catId,
            threadId: caller.threadId,
            userId: caller.userId,
            invocationId: caller.invocationId,
          },
          assignment: { holderCatIds: lease.holderCatIds, holderThreadId: lease.holderThreadId },
        };
        await assertCurrent();
        const result = await this.verifier.invokePredicateVerifier(
          binding.pluginInstanceId,
          binding.completionMethod,
          {
            actionFamily: 'review',
            subjectRef: canonical.subjectRef,
            predicate: canonical,
            leaseId: lease.leaseId,
            generation: lease.generation,
            evidenceRefs: candidate.evidenceRefs,
          },
          context,
        );
        await assertCurrent();
        assertCustodyContract('PredicateCompletionResult', result);
        if (
          result.status === 'verified' &&
          (result.predicateDigest !== canonical.digest ||
            result.freshnessKey !== canonical.freshnessKey ||
            !candidate.evidenceRefs.includes(result.evidenceRef))
        )
          refusePredicateAuthority('Completion result changed the frozen candidate');
        return bindActionCompletionVerdict(result, candidate);
      },
    };
  }

  private canonical(predicate: CanonicalActionTerminalPredicate): CustodyCanonicalPredicate {
    const value = {
      actionFamily: 'review',
      subjectRef: predicate.subjectRef,
      predicate: structuredClone(predicate),
    };
    assertCustodyContract('PredicateFreshnessInput', value);
    return value.predicate;
  }

  private assertBinding(
    snapshot: Pick<PluginInventorySnapshot, 'instances' | 'packages' | 'grants'>,
    binding: ActionTerminalProviderBinding,
    requireInvoke = false,
  ): void {
    if (
      binding.tenantScope !== this.#scope.tenantScope ||
      binding.installationProjectRoot !== this.#scope.installationProjectRoot
    )
      refusePredicateAuthority('Predicate installation scope changed');
    if (
      requireInvoke &&
      !snapshot.grants
        .find((grant) => grant.pluginInstanceId === binding.pluginInstanceId)
        ?.effectiveGrants.includes('custody.invoke')
    )
      refusePredicateAuthority('Bound native caller lacks custody.invoke');
    const matches = authorizedPredicateProviders(snapshot, this.#scope).filter((p) =>
      isDeepStrictEqual(p.binding, binding),
    );
    if (matches.length !== 1 || !matches[0])
      refusePredicateAuthority('Predicate provider binding is no longer authorized');
    assertPredicateProviderRunnable(matches[0]);
  }

  private async assertCurrent(
    binding: ActionTerminalProviderBinding,
    signal: AbortSignal,
    caller?: PluginCallContext,
  ): Promise<void> {
    signal.throwIfAborted();
    await caller?.assertInvocationCurrent?.();
    this.assertBinding(await this.inventory.snapshot(), binding, caller !== undefined);
    signal.throwIfAborted();
    await caller?.assertInvocationCurrent?.();
  }

  private withAuthority<T>(
    binding: ActionTerminalProviderBinding,
    signal: AbortSignal,
    write: () => Promise<T>,
    caller?: PluginCallContext,
  ): Promise<T> {
    return this.inventory.transaction(async (tx) => {
      signal.throwIfAborted();
      // This guard never reenters inventory.snapshot and never calls package code.
      await caller?.assertInvocationCurrent?.();
      this.assertBinding(
        { instances: tx.instances.list(), packages: tx.packages.list(), grants: tx.grants.list() },
        binding,
        caller !== undefined,
      );
      signal.throwIfAborted();
      return write();
    });
  }
}
