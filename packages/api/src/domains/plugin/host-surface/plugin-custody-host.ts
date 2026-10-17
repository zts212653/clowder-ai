import {
  assertCustodyContract,
  type CustodyCanonicalizeInput,
  type CustodyCanonicalizeResult,
  type CustodyCompleteInput,
  type CustodyCompleteResult,
  type CustodyPreflightInput,
  type CustodyPreflightResult,
} from '@clowder-ai/plugin-contract';
import type { ActionSuccessorCompletionService } from '../../ball-custody/ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from '../../ball-custody/ActionSuccessorLeaseStore.js';
import { canonicalizeActionTerminalPredicate } from '../../ball-custody/ActionTerminalPredicateCatalog.js';
import type { ActionPredicateProvider } from '../../ball-custody/action-predicate-authority.js';
import type { ActionSuccessorLease } from '../../ball-custody/action-successor-state-machine.js';
import { currentPluginCallContext, type PluginCallContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export interface PluginCustodyHost {
  canonicalize(input: CustodyCanonicalizeInput): Promise<CustodyCanonicalizeResult>;
  preflight(input: CustodyPreflightInput): Promise<CustodyPreflightResult>;
  complete(input: CustodyCompleteInput): Promise<CustodyCompleteResult>;
}
export interface PluginCustodyServices {
  readonly leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'preflightOutput'>;
  readonly completionService: Pick<ActionSuccessorCompletionService, 'complete'>;
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly ownerUserId: string | undefined;
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly services: PluginCustodyServices | undefined;
  readonly provider: () => ActionPredicateProvider | undefined;
}
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}

/** Native evidence submission only. The package never supplies identity, time or authority. */
export function createPluginCustodyHost(deps: Deps): PluginCustodyHost {
  async function current(): Promise<{ caller: PluginCallContext; services: PluginCustodyServices }> {
    if (!deps.services || !deps.ownerUserId)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host custody services unavailable');
    const caller = currentPluginCallContext(deps.pluginInstanceId);
    if (!caller?.assertInvocationCurrent || !caller.invocationId || caller.userId !== deps.ownerUserId)
      refuse('Custody requires a current owner-scoped native invocation');
    await caller.assertCurrent();
    const snapshot = await deps.inventory.snapshot();
    if (
      !snapshot.grants
        .find((grant) => grant.pluginInstanceId === deps.pluginInstanceId)
        ?.effectiveGrants.includes('custody.invoke')
    )
      refuse('Plugin lacks custody.invoke');
    await caller.assertCurrent();
    return { caller, services: deps.services };
  }
  function bound(lease: ActionSuccessorLease, caller: PluginCallContext): void {
    if (
      lease.actionFamily !== 'review' ||
      lease.terminalPredicate?.kind !== 'review_delivered' ||
      lease.tenantScope !== caller.userId ||
      lease.holderThreadId !== caller.threadId ||
      !lease.holderCatIds.includes(caller.catId) ||
      lease.terminalPredicateProviderBinding?.pluginInstanceId !== deps.pluginInstanceId
    )
      refuse('Lease does not belong to this native invocation and installation');
  }
  return Object.freeze({
    canonicalize: async (input: CustodyCanonicalizeInput) => {
      const value = snapshotPluginProtocolData(input);
      assertCustodyContract('CustodyCanonicalizeInput', value);
      const { caller } = await current();
      const result = { digest: canonicalizeActionTerminalPredicate(value).digest };
      await caller.assertCurrent();
      assertCustodyContract('CustodyCanonicalizeResult', result);
      return Object.freeze(result);
    },
    preflight: async (input: CustodyPreflightInput) => {
      const value = snapshotPluginProtocolData(input);
      assertCustodyContract('CustodyPreflightInput', value);
      const { caller, services } = await current();
      const lease = await services.leaseStore.get(value.leaseId);
      await caller.assertCurrent();
      if (!lease) return { ok: false as const, reason: 'lease_missing' };
      bound(lease, caller);
      const authorization = await deps.provider()?.authorizeCompletion(lease, { catId: caller.catId });
      if (!authorization || authorization.status !== 'authorized')
        return { ok: false as const, reason: authorization?.reason ?? 'predicate provider authority unavailable' };
      const result = await authorization.withAuthority(() =>
        services.leaseStore.preflightOutput(
          value.leaseId,
          value.generation,
          caller.catId,
          value.terminalPredicateDigest,
        ),
      );
      await caller.assertCurrent();
      assertCustodyContract('CustodyPreflightResult', result);
      return Object.freeze({ ...result });
    },
    complete: async (input: CustodyCompleteInput) => {
      const value = snapshotPluginProtocolData(input);
      assertCustodyContract('CustodyCompleteInput', value);
      const { caller, services } = await current();
      const lease = await services.leaseStore.get(value.leaseId);
      await caller.assertCurrent();
      if (!lease) return { outcome: 'stale' as const, reason: 'lease_missing' };
      bound(lease, caller);
      // The existing service independently reauthorizes before replay, candidate writes and final CAS.
      const result = await services.completionService.complete({
        leaseId: value.leaseId,
        generation: value.generation,
        evidenceRefs: [...value.evidenceRefs],
        catId: caller.catId,
        now: Date.now(),
      });
      await caller.assertCurrent();
      assertCustodyContract('CustodyCompleteResult', result);
      return Object.freeze({ ...result });
    },
  });
}
