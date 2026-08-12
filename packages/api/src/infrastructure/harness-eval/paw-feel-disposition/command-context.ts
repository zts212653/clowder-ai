import type { PawFeelDispositionCommand, PawFeelResolvedCommandContext, PawFeelResolvedFix } from './commands.js';
import { PawFeelDispositionServiceError, type PawFeelTrustedPrincipal } from './service-guards.js';

export interface PawFeelFixResolver {
  resolve(leaseId: string): Promise<PawFeelResolvedFix>;
}

async function resolveFix(leaseId: string, resolver?: PawFeelFixResolver): Promise<PawFeelResolvedFix> {
  if (!resolver) {
    throw new PawFeelDispositionServiceError(
      'fix_evidence_invalid',
      'fix requires a task owner and active F167 lease resolver',
    );
  }
  try {
    const fix = await resolver.resolve(leaseId);
    if (fix.leaseId !== leaseId) throw new Error('resolved lease identity mismatch');
    return fix;
  } catch (error) {
    throw new PawFeelDispositionServiceError(
      'fix_evidence_invalid',
      `fix requires a real task/owner/active lease: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function resolvePawFeelCommandContext(
  actor: PawFeelTrustedPrincipal,
  command: PawFeelDispositionCommand,
  fixResolver: PawFeelFixResolver | undefined,
  ownerCatId: string | undefined,
): Promise<PawFeelResolvedCommandContext> {
  if (command.type === 'mark_fix') return { fix: await resolveFix(command.leaseId, fixResolver) };
  if (command.type === 'request_signature') {
    if (actor.kind !== 'cat') {
      throw new PawFeelDispositionServiceError('named_owner_required', 'signature request requires a cat reviewer');
    }
    if (command.action.type === 'duplicate') {
      return { signatureAction: { type: 'duplicate', duplicateOf: command.action.duplicateOf } };
    }
    if (command.action.type === 'no_action') {
      return { signatureAction: { type: 'no_action', reasonCode: command.action.reasonCode } };
    }
    return { signatureAction: { type: 'fix', ...(await resolveFix(command.action.leaseId, fixResolver)) } };
  }
  if (command.type !== 'mark_duplicate' && command.type !== 'mark_no_action') return {};
  if (actor.kind !== 'cat') {
    throw new PawFeelDispositionServiceError(
      'named_owner_required',
      `${command.type} requires a cat-signed named lightweight owner`,
    );
  }
  if (ownerCatId && ownerCatId !== actor.id) {
    throw new PawFeelDispositionServiceError('named_owner_required', 'cat actor may only sign itself as owner');
  }
  return { ownerCatId: actor.id };
}
