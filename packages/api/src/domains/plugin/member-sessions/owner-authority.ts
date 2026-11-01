import { currentOwnerOperation } from '../carrier/plugin-owner-operation-context.js';
import { currentPluginOwnerRequestContext } from '../carrier/plugin-owner-request-context.js';
import type { MemberSessionScope, OwnerMemberRequest } from './types.js';

export function ownerRequest(scope: MemberSessionScope, requiresConfirmation = true): OwnerMemberRequest {
  const operation = currentOwnerOperation(scope.pluginInstanceId);
  if (operation && operation.userId === scope.ownerUserId && !operation.signal.aborted) {
    if (requiresConfirmation && operation.confirmed !== true)
      throw new Error('member_session_owner_confirmation_required');
    return { requestId: operation.requestId, assertCurrent: () => operation.assertCurrent() };
  }
  const request = currentPluginOwnerRequestContext(scope.pluginInstanceId);
  if (
    request?.operation === 'write' &&
    request.userId === scope.ownerUserId &&
    request.requestIdentity &&
    !request.signal.aborted
  )
    return { requestId: request.requestIdentity.requestId, assertCurrent: () => request.assertCurrent() };
  throw new Error('member_session_owner_authority_required');
}
