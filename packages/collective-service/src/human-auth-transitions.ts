import { CollectiveServiceError } from './errors.js';
import type { ExternalHumanIdentity, HumanAuthProviderId } from './human-auth-provider.js';
import { createSecret, createStableId, digestSecret, secretMatches } from './persistence.js';
import {
  type HumanAuthIntent,
  type HumanRecord,
  type MutableServiceState,
  membershipKey,
  type ServiceState,
  type SessionRecord,
} from './state.js';

export function findAuthAttempt<State extends Pick<ServiceState, 'humanAuthAttempts'>>(
  state: State,
  provider: HumanAuthProviderId,
  stateSecret: string,
): State['humanAuthAttempts'][string] {
  const attempt = Object.values(state.humanAuthAttempts).find(
    (candidate) => candidate.provider === provider && secretMatches(stateSecret, candidate.stateDigest),
  ) as State['humanAuthAttempts'][string] | undefined;
  if (!attempt) throw new CollectiveServiceError('AUTH_ATTEMPT_INVALID', 'Human auth attempt is invalid', 401);
  return attempt;
}

export function validatePendingAttempt(attempt: ServiceState['humanAuthAttempts'][string], now: number): void {
  if (attempt.consumedAt) {
    throw new CollectiveServiceError('AUTH_ATTEMPT_CONSUMED', 'Human auth attempt was already consumed', 409);
  }
  if (Date.parse(attempt.expiresAt) < now) {
    throw new CollectiveServiceError('AUTH_ATTEMPT_EXPIRED', 'Human auth attempt expired', 410);
  }
}

export function validateExternalIdentity(identity: ExternalHumanIdentity): void {
  if (
    !identity.providerSubject.trim() ||
    !identity.handle.trim() ||
    !identity.displayName.trim() ||
    identity.providerSubject.length > 240 ||
    identity.handle.length > 160 ||
    identity.displayName.length > 160
  ) {
    throw new CollectiveServiceError('AUTH_IDENTITY_INVALID', 'Human auth provider returned an invalid identity', 502);
  }
  if (identity.avatarUrl) {
    try {
      const url = new URL(identity.avatarUrl);
      if (url.protocol !== 'https:') throw new Error('avatar protocol');
    } catch {
      throw new CollectiveServiceError('AUTH_IDENTITY_INVALID', 'Human auth provider returned an invalid avatar', 502);
    }
  }
}

export function applyAuthenticatedIdentity(
  state: MutableServiceState,
  intent: HumanAuthIntent,
  provider: HumanAuthProviderId,
  identity: ExternalHumanIdentity,
  now: number,
): { human: HumanRecord; collectiveId?: string } {
  const existingBinding = Object.values(state.humanAuthBindings).find(
    (binding) => binding.provider === provider && binding.providerSubject === identity.providerSubject,
  );
  if (intent.kind === 'bind') {
    return bindAuthenticatedIdentity(state, intent.humanId, provider, identity, existingBinding, now);
  }
  if (intent.kind === 'login') return loginAuthenticatedIdentity(state, provider, identity, existingBinding, now);
  return acceptInviteIdentity(state, intent.inviteId, provider, identity, existingBinding, now);
}

type ExistingBinding = MutableServiceState['humanAuthBindings'][string] | undefined;

function bindAuthenticatedIdentity(
  state: MutableServiceState,
  humanId: string,
  provider: HumanAuthProviderId,
  identity: ExternalHumanIdentity,
  existingBinding: ExistingBinding,
  now: number,
): { human: HumanRecord } {
  const human = state.humans[humanId];
  if (!human) throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Human identity no longer exists', 409);
  if (existingBinding && existingBinding.humanId !== human.humanId) {
    throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Provider identity is already bound', 409);
  }
  const otherBinding = Object.values(state.humanAuthBindings).find(
    (binding) => binding.provider === provider && binding.humanId === human.humanId,
  );
  if (otherBinding && otherBinding.providerSubject !== identity.providerSubject) {
    throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Human already has a different provider binding', 409);
  }
  upsertBinding(state, human, provider, identity, existingBinding?.bindingId, now);
  refreshHumanProfile(human, identity);
  return { human };
}

function loginAuthenticatedIdentity(
  state: MutableServiceState,
  provider: HumanAuthProviderId,
  identity: ExternalHumanIdentity,
  existingBinding: ExistingBinding,
  now: number,
): { human: HumanRecord } {
  if (!existingBinding) {
    throw new CollectiveServiceError('AUTH_BINDING_REQUIRED', 'Provider identity is not bound to a Human', 403);
  }
  const human = state.humans[existingBinding.humanId];
  if (!human) throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Bound Human identity is missing', 409);
  upsertBinding(state, human, provider, identity, existingBinding.bindingId, now);
  refreshHumanProfile(human, identity);
  return { human };
}

function acceptInviteIdentity(
  state: MutableServiceState,
  inviteId: string,
  provider: HumanAuthProviderId,
  identity: ExternalHumanIdentity,
  existingBinding: ExistingBinding,
  now: number,
): { human: HumanRecord; collectiveId: string } {
  const invite = state.invites[inviteId];
  validateInvite(invite, now);
  const human = existingBinding
    ? state.humans[existingBinding.humanId]
    : createHumanRecord(state, identity.displayName, now, identity.avatarUrl);
  if (!human) throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Bound Human identity is missing', 409);
  if (state.memberships[membershipKey(invite.collectiveId, human.humanId)]) {
    throw new CollectiveServiceError('AUTH_IDENTITY_CONFLICT', 'Human is already a Collective member', 409);
  }
  upsertBinding(state, human, provider, identity, existingBinding?.bindingId, now);
  refreshHumanProfile(human, identity);
  invite.consumedAt = new Date(now).toISOString();
  state.memberships[membershipKey(invite.collectiveId, human.humanId)] = {
    collectiveId: invite.collectiveId,
    humanId: human.humanId,
    role: 'member',
    joinedAt: new Date(now).toISOString(),
  };
  return { human, collectiveId: invite.collectiveId };
}

export function validateInvite(
  invite: MutableServiceState['invites'][string] | ServiceState['invites'][string] | undefined,
  now: number,
): asserts invite is MutableServiceState['invites'][string] | ServiceState['invites'][string] {
  if (!invite || invite.consumedAt) throw new CollectiveServiceError('INVITE_INVALID', 'Invite is invalid', 401);
  if (Date.parse(invite.expiresAt) < now) {
    throw new CollectiveServiceError('INVITE_EXPIRED', 'Invite expired', 410);
  }
}

export function createHumanSession(state: MutableServiceState, displayName: string, now: number) {
  const human = createHumanRecord(state, displayName, now);
  const sessionToken = createSecret();
  const session: SessionRecord = {
    sessionId: createStableId('session_'),
    humanId: human.humanId,
    tokenDigest: digestSecret(sessionToken),
    createdAt: human.createdAt,
  };
  state.sessions[session.sessionId] = session;
  return { human, sessionToken };
}

export function requiredIdentityLabel(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) {
    throw new CollectiveServiceError('FORBIDDEN', `${field} is required`, 400);
  }
  return normalized;
}

function upsertBinding(
  state: MutableServiceState,
  human: HumanRecord,
  provider: HumanAuthProviderId,
  identity: ExternalHumanIdentity,
  existingBindingId: string | undefined,
  now: number,
): void {
  const bindingId = existingBindingId ?? createStableId('binding_');
  const previous = state.humanAuthBindings[bindingId];
  state.humanAuthBindings[bindingId] = {
    bindingId,
    humanId: human.humanId,
    provider,
    providerSubject: identity.providerSubject,
    handle: identity.handle,
    ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    createdAt: previous?.createdAt ?? new Date(now).toISOString(),
    lastAuthenticatedAt: new Date(now).toISOString(),
  };
}

type DeepMutableHuman = MutableServiceState['humans'][string];

function refreshHumanProfile(human: DeepMutableHuman, identity: ExternalHumanIdentity): void {
  human.displayName = identity.displayName.trim();
  if (identity.avatarUrl) human.avatarUrl = identity.avatarUrl;
  else delete human.avatarUrl;
}

function createHumanRecord(
  state: MutableServiceState,
  displayName: string,
  now: number,
  avatarUrl?: string,
): DeepMutableHuman {
  const normalizedName = requiredIdentityLabel(displayName, 'displayName');
  const human: DeepMutableHuman = {
    humanId: createStableId('human_'),
    displayName: normalizedName,
    ...(avatarUrl ? { avatarUrl } : {}),
    createdAt: new Date(now).toISOString(),
  };
  state.humans[human.humanId] = human;
  return human;
}
