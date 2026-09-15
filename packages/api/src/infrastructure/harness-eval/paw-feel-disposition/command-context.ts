import type { PawFeelDispositionCommand, PawFeelResolvedCommandContext, PawFeelResolvedFix } from './commands.js';
import { PawFeelDispositionServiceError, type PawFeelTrustedPrincipal } from './service-guards.js';

export interface PawFeelFixResolver {
  resolve(leaseId: string): Promise<PawFeelResolvedFix>;
}

export async function resolvePawFeelCommandContext(
  actor: PawFeelTrustedPrincipal,
  command: PawFeelDispositionCommand,
  ownerCatId: string | undefined,
): Promise<PawFeelResolvedCommandContext> {
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
    return {};
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
