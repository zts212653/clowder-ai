import { type PawFeelDirectRepairBindingV1, type PawFeelDispositionProjection, refIdentity } from '@cat-cafe/shared';
import { PawFeelDirectRepairBindingV1Schema } from '../schema.js';
import { PawFeelDirectRepairError, type PawFeelDirectRepairErrorCode } from './direct-repair-errors.js';
import type { PawFeelDirectRepairFederation, SelectedPawFeelDirectRepairProvider } from './direct-repair-federation.js';
import type { PawFeelDirectRepairSourceVerifier } from './direct-repair-source.js';

export type PawFeelDirectRepairBindingStatus =
  | { status: 'current'; evidenceRefs: string[] }
  | { status: 'blocked'; reasonCode: PawFeelDirectRepairErrorCode; evidenceRefs: string[] };

export interface PawFeelDirectRepairBindingVerifierOptions {
  sourceVerifier: Pick<PawFeelDirectRepairSourceVerifier, 'verify'>;
  federation: PawFeelDirectRepairFederation;
}

function sameRef(left: PawFeelDirectRepairBindingV1['bindingRef'], right: PawFeelDirectRepairBindingV1['bindingRef']) {
  return refIdentity(left) === refIdentity(right);
}

function evidenceRefs(binding: PawFeelDirectRepairBindingV1): string[] {
  return [
    binding.bindingRef.ownerStateRef,
    binding.sourceSignalRef.ownerStateRef,
    binding.sourceToolRef.ownerStateRef,
    binding.providerRouteRef.ownerStateRef,
  ];
}

export class PawFeelDirectRepairBindingVerifier {
  constructor(private readonly options: PawFeelDirectRepairBindingVerifierOptions) {}

  async verify(
    projection: PawFeelDispositionProjection,
    rawBinding: PawFeelDirectRepairBindingV1,
  ): Promise<SelectedPawFeelDirectRepairProvider> {
    const binding = PawFeelDirectRepairBindingV1Schema.parse(rawBinding);
    const activeBinding = projection.directRepairBinding
      ? PawFeelDirectRepairBindingV1Schema.parse(projection.directRepairBinding)
      : undefined;
    if (projection.state !== 'fix' || !activeBinding || JSON.stringify(activeBinding) !== JSON.stringify(binding)) {
      throw new PawFeelDirectRepairError('binding_mismatch', 'signal has no active direct repair binding');
    }
    const source = await this.options.sourceVerifier.verify(projection);
    if (
      !sameRef(source.sourceSignalRef, binding.sourceSignalRef) ||
      !sameRef(source.sourceToolRef, binding.sourceToolRef)
    ) {
      throw new PawFeelDirectRepairError('source_mismatch', 'repair source no longer matches its binding');
    }
    const selected = this.options.federation.select(source.sourceToolRef);
    if (
      selected.route.providerId !== binding.providerId ||
      selected.route.providerVersion !== binding.providerVersion ||
      !sameRef(selected.providerRouteRef, binding.providerRouteRef)
    ) {
      throw new PawFeelDirectRepairError('binding_mismatch', 'selected provider route or version drifted');
    }
    return selected;
  }

  async resolveStatus(projection: PawFeelDispositionProjection): Promise<PawFeelDirectRepairBindingStatus> {
    let binding: PawFeelDirectRepairBindingV1;
    try {
      binding = PawFeelDirectRepairBindingV1Schema.parse(projection.directRepairBinding);
    } catch {
      return { status: 'blocked', reasonCode: 'binding_mismatch', evidenceRefs: [projection.signalId] };
    }
    try {
      await this.verify(projection, binding);
      return { status: 'current', evidenceRefs: evidenceRefs(binding) };
    } catch (error) {
      return {
        status: 'blocked',
        reasonCode: error instanceof PawFeelDirectRepairError ? error.code : 'binding_mismatch',
        evidenceRefs: evidenceRefs(binding),
      };
    }
  }
}
