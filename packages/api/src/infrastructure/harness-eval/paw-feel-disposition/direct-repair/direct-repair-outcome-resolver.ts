import {
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDirectRepairOutcomeV1,
  type PawFeelDispositionActor,
  type PawFeelDispositionProjection,
  refIdentity,
} from '@cat-cafe/shared';
import { PawFeelDirectRepairBindingV1Schema, PawFeelDirectRepairOutcomeV1Schema } from '../schema.js';
import type { PawFeelDirectRepairBindingVerifier } from './direct-repair-binding-verifier.js';
import { PawFeelDirectRepairError } from './direct-repair-errors.js';

export interface PawFeelRepairTerminalTruth {
  ownerCatId: string;
  taskTerminalRef: OwnerTruthRefV1;
  leaseTerminalRef: OwnerTruthRefV1;
}

export interface PawFeelRepairTerminalResolver {
  resolve(
    projection: PawFeelDispositionProjection,
    binding: PawFeelDirectRepairBindingV1,
  ): Promise<PawFeelRepairTerminalTruth>;
}

export interface PawFeelDirectRepairOutcomeResolverOptions {
  bindingVerifier: Pick<PawFeelDirectRepairBindingVerifier, 'verify'>;
  terminalResolver: PawFeelRepairTerminalResolver;
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

interface ResolveOutcomeInput {
  projection: PawFeelDispositionProjection;
  actor: Extract<PawFeelDispositionActor, { kind: 'cat' | 'cvo' }>;
  bindingRef: OwnerTruthRefV1;
  ownerOutcomeRef: OwnerTruthRefV1;
}

function requireBinding(input: ResolveOutcomeInput): PawFeelDirectRepairBindingV1 {
  const binding = input.projection.directRepairBinding
    ? PawFeelDirectRepairBindingV1Schema.parse(input.projection.directRepairBinding)
    : undefined;
  if (input.projection.state !== 'fix' || !binding) {
    throw new PawFeelDirectRepairError('binding_mismatch', 'signal has no active direct repair binding');
  }
  if (!sameRef(binding.bindingRef, ownerTruthRefV1Schema.parse(input.bindingRef))) {
    throw new PawFeelDirectRepairError('binding_mismatch', 'callback binding does not match the active fix');
  }
  if (
    input.actor.kind !== 'cat' ||
    input.actor.id !== binding.ownerCatId ||
    input.actor.id !== input.projection.ownerCatId
  ) {
    throw new PawFeelDirectRepairError('owner_mismatch', 'repair outcome requires the bound owner cat');
  }
  return binding;
}

export class PawFeelDirectRepairOutcomeResolver {
  constructor(private readonly options: PawFeelDirectRepairOutcomeResolverOptions) {}

  async resolve(input: ResolveOutcomeInput): Promise<PawFeelDirectRepairOutcomeV1> {
    const binding = requireBinding(input);
    const selected = await this.options.bindingVerifier.verify(input.projection, binding);

    const terminal = await this.resolveTerminal(input.projection, binding);

    const ownerOutcomeRef = ownerTruthRefV1Schema.parse(input.ownerOutcomeRef);
    let outcome: PawFeelDirectRepairOutcomeV1;
    try {
      outcome = PawFeelDirectRepairOutcomeV1Schema.parse(
        await selected.provider.verifyOutcome({
          binding,
          ownerOutcomeRef,
          taskTerminalRef: terminal.taskTerminalRef,
          leaseTerminalRef: terminal.leaseTerminalRef,
        }),
      );
    } catch (error) {
      throw new PawFeelDirectRepairError(
        'outcome_invalid',
        `owner outcome verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !sameRef(outcome.bindingRef, binding.bindingRef) ||
      !sameRef(outcome.ownerOutcomeRef, ownerOutcomeRef) ||
      !sameRef(outcome.taskTerminalRef, terminal.taskTerminalRef) ||
      !sameRef(outcome.leaseTerminalRef, terminal.leaseTerminalRef)
    ) {
      throw new PawFeelDirectRepairError(
        'outcome_invalid',
        'owner outcome does not match the exact binding and terminal refs',
      );
    }
    return outcome;
  }

  private async resolveTerminal(
    projection: PawFeelDispositionProjection,
    binding: PawFeelDirectRepairBindingV1,
  ): Promise<PawFeelRepairTerminalTruth> {
    let terminal: PawFeelRepairTerminalTruth;
    try {
      terminal = await this.options.terminalResolver.resolve(projection, binding);
      ownerTruthRefV1Schema.parse(terminal.taskTerminalRef);
      ownerTruthRefV1Schema.parse(terminal.leaseTerminalRef);
    } catch (error) {
      throw new PawFeelDirectRepairError(
        'terminal_evidence_invalid',
        `Task/F167 terminal truth is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (terminal.ownerCatId !== binding.ownerCatId) {
      throw new PawFeelDirectRepairError('owner_mismatch', 'terminal task/lease owner differs from the binding');
    }
    return terminal;
  }
}
