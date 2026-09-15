import { type PawFeelBundleAction, PawFeelBundleCommandSchema, type PawFeelDispositionCommand } from '../commands.js';
import { PawFeelDispositionServiceError } from '../service-guards.js';

export interface PawFeelBundleMembershipResolver {
  assertBundleSnapshot(
    bundleKey: string,
    members: readonly { signalId: string; expectedSequence: number }[],
    membershipToken: string,
  ): Promise<void>;
}

function commandForMember(
  action: PawFeelBundleAction,
  member: { signalId: string; expectedSequence: number },
  eventId: string,
): PawFeelDispositionCommand {
  const base = { eventId, signalId: member.signalId, expectedSequence: member.expectedSequence };
  if (action.type === 'duplicate') return { ...base, type: 'mark_duplicate', duplicateOf: action.duplicateOf };
  if (action.type === 'no_action') return { ...base, type: 'mark_no_action', reasonCode: action.reasonCode };
  if (action.type === 'fix') {
    return { ...base, type: 'mark_fix', leaseId: action.leaseId, actionRef: action.actionRef };
  }
  if (action.type === 'request_signature') {
    return {
      ...base,
      type: 'request_signature',
      action: action.action,
      ...(action.preferredSignerCatId ? { preferredSignerCatId: action.preferredSignerCatId } : {}),
    };
  }
  return {
    ...base,
    type: 'mark_blocked',
    blockerCode: action.blockerCode,
    blockerRef: action.blockerRef,
    resume: action.resume,
  };
}

export async function preparePawFeelBundleCommands(
  rawBundle: unknown,
  membershipResolver?: PawFeelBundleMembershipResolver,
): Promise<{ bundleKey: string; commands: PawFeelDispositionCommand[] }> {
  const parsed = PawFeelBundleCommandSchema.safeParse(rawBundle);
  if (!parsed.success) {
    throw new PawFeelDispositionServiceError('bundle_invalid', `invalid bundle command: ${parsed.error.message}`);
  }
  const bundle = parsed.data;
  const memberIds = bundle.members.map((member) => member.signalId);
  if (new Set(memberIds).size !== memberIds.length) {
    throw new PawFeelDispositionServiceError('bundle_invalid', 'bundle contains duplicate signal IDs');
  }
  const exceptions = new Map<string, PawFeelBundleAction>();
  for (const exception of bundle.exceptions ?? []) {
    if (!memberIds.includes(exception.signalId)) {
      throw new PawFeelDispositionServiceError(
        'bundle_invalid',
        `bundle exception ${exception.signalId} is not in the submitted snapshot`,
      );
    }
    if (exceptions.has(exception.signalId)) {
      throw new PawFeelDispositionServiceError('bundle_invalid', `duplicate exception for ${exception.signalId}`);
    }
    exceptions.set(exception.signalId, exception.action);
  }
  if (!membershipResolver) {
    throw new PawFeelDispositionServiceError(
      'bundle_invalid',
      'bundle actions require authoritative membership resolution',
    );
  }
  try {
    await membershipResolver.assertBundleSnapshot(bundle.bundleKey, bundle.members, bundle.membershipToken);
  } catch (error) {
    throw new PawFeelDispositionServiceError(
      'bundle_invalid',
      `bundle membership mismatch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    bundleKey: bundle.bundleKey,
    commands: bundle.members.map((member, index) =>
      commandForMember(exceptions.get(member.signalId) ?? bundle.action, member, `${bundle.eventIdPrefix}:${index}`),
    ),
  };
}
