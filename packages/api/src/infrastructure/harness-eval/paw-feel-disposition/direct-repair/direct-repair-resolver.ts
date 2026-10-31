import { createHash } from 'node:crypto';
import {
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  type PawFeelApprovalContinuationV1,
  type PawFeelDirectRepairAuthorityDecisionV1,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDispositionProjection,
  type PawFeelRepairRequest,
  pawFeelRepairBinding,
  pawFeelRepairRequest,
  refIdentity,
  repairRequestForBinding,
} from '@cat-cafe/shared';
import type { PawFeelFixResolver } from '../command-context.js';
import type { PawFeelResolvedFix } from '../commands.js';
import { PawFeelDirectRepairBindingV1Schema } from '../schema.js';
import { PawFeelDirectRepairError } from './direct-repair-errors.js';
import type { PawFeelDirectRepairFederation } from './direct-repair-federation.js';
import type {
  PawFeelDirectRepairSourceVerifier,
  VerifiedPawFeelDirectRepairSourceContext,
} from './direct-repair-source.js';

export interface PawFeelApprovalContinuationResolver {
  resolve(input: {
    projection: PawFeelDispositionProjection;
    source: VerifiedPawFeelDirectRepairSourceContext;
  }): Promise<PawFeelApprovalContinuationV1>;
}

export interface PawFeelDirectRepairResolverOptions {
  sourceVerifier: PawFeelDirectRepairSourceVerifier;
  federation: PawFeelDirectRepairFederation;
  custodyResolver: PawFeelFixResolver;
  approvalContinuationResolver: PawFeelApprovalContinuationResolver;
}

export type PawFeelDirectRepairResolution =
  | { status: 'authorized'; fix: PawFeelResolvedFix; binding: PawFeelDirectRepairBindingV1 }
  | { status: 'continuation'; continuation: PawFeelApprovalContinuationV1 };

function deriveBindingRef(
  source: VerifiedPawFeelDirectRepairSourceContext,
  providerId: string,
  providerVersion: string,
  providerRouteRef: PawFeelDirectRepairBindingV1['providerRouteRef'],
  authority: Omit<
    PawFeelDirectRepairBindingV1,
    'bindingRef' | 'sourceSignalRef' | 'sourceToolRef' | 'providerId' | 'providerVersion' | 'providerRouteRef'
  >,
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        refIdentity(source.sourceSignalRef),
        refIdentity(source.sourceToolRef),
        providerId,
        providerVersion,
        refIdentity(providerRouteRef),
        refIdentity(authority.resolvedActionRef),
        refIdentity(authority.actionScopeRef),
        refIdentity(authority.ownerAuthorizationRef),
        refIdentity(authority.targetVersionRef),
        authority.ownerCatId,
        refIdentity(authority.outcomeVerifierRef),
      ]),
    )
    .digest('hex');
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F278',
    ownerStateRef: `paw-feel-direct-repair-binding:sha256:${digest}`,
  });
}

function requireResolvedCustody(fix: PawFeelResolvedFix, requested: PawFeelRepairRequest): PawFeelResolvedFix {
  const binding = pawFeelRepairBinding(fix);
  if (
    !binding ||
    JSON.stringify(repairRequestForBinding(binding)) !== JSON.stringify(requested) ||
    !fix.ownerCatId.trim() ||
    !fix.taskId.trim() ||
    !fix.custodyEvidenceRef.trim()
  ) {
    throw new PawFeelDirectRepairError(
      'terminal_evidence_invalid',
      'repair responsibility differs from the exact requested reference',
    );
  }
  return fix;
}

export class PawFeelDirectRepairResolver {
  constructor(private readonly options: PawFeelDirectRepairResolverOptions) {}

  async resolve(input: {
    projection: PawFeelDispositionProjection;
    leaseId?: string;
    repairBinding?: PawFeelRepairRequest;
    userId?: string;
    actionRef: string;
  }): Promise<PawFeelDirectRepairResolution> {
    const source = await this.options.sourceVerifier.verify(input.projection);
    const selected = this.options.federation.select(source.sourceToolRef);
    const actionRef = typeof input.actionRef === 'string' ? input.actionRef.trim() : '';
    if (!actionRef) throw new PawFeelDirectRepairError('action_not_found', 'actionRef must be non-empty');
    const requested = pawFeelRepairRequest(input);
    const fix = requireResolvedCustody(
      await this.options.custodyResolver.resolve(
        requested.kind === 'action_lease' ? requested.leaseId : requested,
        input.userId,
      ),
      requested,
    );
    let decision: PawFeelDirectRepairAuthorityDecisionV1;
    try {
      decision = await selected.provider.resolveAuthority({ source, custody: fix, actionRef });
    } catch (error) {
      throw new PawFeelDirectRepairError(
        'provider_unavailable',
        `selected provider failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (decision.status === 'blocked') {
      ownerTruthRefV1Schema.parse(decision.blockerRef);
      throw new PawFeelDirectRepairError(decision.reason, `direct repair blocked: ${decision.reason}`);
    }
    if (decision.status === 'authority_required') {
      ownerTruthRefV1Schema.parse(decision.resolvedActionRef);
      ownerTruthRefV1Schema.parse(decision.blockerRef);
      exactAssetVersionRefV1Schema.parse(decision.targetVersionRef);
      return {
        status: 'continuation',
        continuation: await this.options.approvalContinuationResolver.resolve({
          projection: input.projection,
          source,
        }),
      };
    }
    if (decision.authority.ownerCatId !== fix.ownerCatId) {
      throw new PawFeelDirectRepairError('owner_mismatch', 'action owner does not match task/F167 holder');
    }
    const authority = decision.authority;
    const binding = PawFeelDirectRepairBindingV1Schema.parse({
      ...authority,
      bindingRef: deriveBindingRef(
        source,
        selected.route.providerId,
        selected.route.providerVersion,
        selected.providerRouteRef,
        authority,
      ),
      sourceSignalRef: source.sourceSignalRef,
      sourceToolRef: source.sourceToolRef,
      providerId: selected.route.providerId,
      providerVersion: selected.route.providerVersion,
      providerRouteRef: selected.providerRouteRef,
    });
    return { status: 'authorized', fix, binding };
  }
}
