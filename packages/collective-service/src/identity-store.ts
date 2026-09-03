import { CollectiveServiceError } from './errors.js';
import type { HumanAuthProvider, HumanAuthProviderId } from './human-auth-provider.js';
import {
  applyAuthenticatedIdentity,
  createHumanSession,
  findAuthAttempt,
  requiredIdentityLabel,
  validateExternalIdentity,
  validateInvite,
  validatePendingAttempt,
} from './human-auth-transitions.js';
import {
  createSecret,
  createStableId,
  digestSecret,
  type PersistentServiceState,
  secretMatches,
} from './persistence.js';
import {
  type CollectiveRecord,
  type HumanAuthIntent,
  type HumanRecord,
  type MembershipRecord,
  membershipKey,
  type ServiceState,
  type SessionRecord,
} from './state.js';

export interface AuthenticatedHuman {
  readonly human: HumanRecord;
  readonly session: SessionRecord;
}

export type BeginHumanAuthIntent =
  | { readonly kind: 'bind' }
  | { readonly kind: 'accept_invite'; readonly inviteToken: string }
  | { readonly kind: 'login' };

export class CollectiveIdentityStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
    private readonly humanAuthProvider?: HumanAuthProvider,
    private readonly humanAuthRedirectUri = 'http://127.0.0.1/api/auth/github/callback',
  ) {}

  getHumanAuthRedirectUri(): string {
    return this.humanAuthRedirectUri;
  }

  async consumeBootstrap(input: { secret: string; displayName: string }) {
    const displayName = requiredIdentityLabel(input.displayName, 'displayName');
    return this.persistence.transaction((state) => {
      if (state.bootstrap.consumedAt) {
        throw new CollectiveServiceError('BOOTSTRAP_ALREADY_CONSUMED', 'Owner bootstrap was already consumed', 409);
      }
      const now = this.now();
      if (Date.parse(state.bootstrap.expiresAt) < now) {
        throw new CollectiveServiceError('BOOTSTRAP_EXPIRED', 'Owner bootstrap expired', 410);
      }
      if (!secretMatches(input.secret, state.bootstrap.tokenDigest)) {
        throw new CollectiveServiceError('INVALID_BOOTSTRAP', 'Owner bootstrap is invalid', 401);
      }
      state.bootstrap.consumedAt = new Date(now).toISOString();
      const owner = createHumanSession(state, displayName, now);
      state.bootstrap.ownerHumanId = owner.human.humanId;
      return owner;
    });
  }

  async requireSession(sessionToken: string): Promise<AuthenticatedHuman> {
    return resolveSession(this.persistence.snapshot(), sessionToken);
  }

  async createCollective(input: { sessionToken: string; name: string }): Promise<CollectiveRecord> {
    const name = requiredIdentityLabel(input.name, 'name');
    return this.persistence.transaction((state) => {
      const { human } = resolveSession(state, input.sessionToken);
      const createsInitialBootstrapCollective =
        state.bootstrap.ownerHumanId === human.humanId && Object.keys(state.collectives).length === 0;
      if (!createsInitialBootstrapCollective) requireHumanAuthBinding(state, human.humanId);
      const now = this.now();
      const collective: CollectiveRecord = {
        collectiveId: createStableId('col_'),
        name,
        createdByHumanId: human.humanId,
        createdAt: new Date(now).toISOString(),
      };
      state.collectives[collective.collectiveId] = collective;
      state.memberships[membershipKey(collective.collectiveId, human.humanId)] = {
        collectiveId: collective.collectiveId,
        humanId: human.humanId,
        role: 'steward',
        joinedAt: collective.createdAt,
      };
      state.events[collective.collectiveId] = [];
      return collective;
    });
  }

  async listCollectives(sessionToken: string): Promise<CollectiveRecord[]> {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    const collectiveIds = Object.values(state.memberships)
      .filter((membership) => membership.humanId === human.humanId)
      .map((membership) => membership.collectiveId);
    return collectiveIds
      .map((collectiveId) => state.collectives[collectiveId])
      .filter((collective): collective is CollectiveRecord => collective !== undefined);
  }

  async getHumanProjection(sessionToken: string) {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    const binding = findHumanAuthBinding(state, human.humanId);
    const collectives = Object.values(state.memberships)
      .filter((membership) => membership.humanId === human.humanId)
      .map((membership) => ({
        ...state.collectives[membership.collectiveId],
        role: membership.role,
      }))
      .filter((collective) => collective.collectiveId !== undefined);
    return {
      human,
      auth: binding
        ? {
            provider: binding.provider,
            handle: binding.handle,
          }
        : null,
      collectives,
    };
  }

  async createInvite(input: { sessionToken: string; collectiveId: string; ttlMs?: number }) {
    return this.persistence.transaction((state) => {
      const auth = resolveSession(state, input.sessionToken);
      requireHumanAuthBinding(state, auth.human.humanId);
      requireSteward(state, input.collectiveId, auth.human.humanId);
      const now = this.now();
      const inviteToken = createSecret();
      const inviteId = createStableId('invite_');
      state.invites[inviteId] = {
        inviteId,
        collectiveId: input.collectiveId,
        tokenDigest: digestSecret(inviteToken),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (input.ttlMs ?? 24 * 60 * 60 * 1_000)).toISOString(),
      };
      return { inviteId, inviteToken, collectiveId: input.collectiveId };
    });
  }

  getHumanAuthProviders() {
    const provider = this.humanAuthProvider;
    return [
      {
        id: 'github' as const,
        ready: provider?.id === 'github' && provider.readiness.ready,
        ...(!(provider?.id === 'github' && provider.readiness.ready)
          ? { reason: provider?.readiness.ready === false ? provider.readiness.reason : ('not_configured' as const) }
          : {}),
      },
    ];
  }

  async beginHumanAuth(input: {
    provider: HumanAuthProviderId;
    intent: BeginHumanAuthIntent;
    sessionToken?: string;
    ttlMs?: number;
  }) {
    const provider = this.requireReadyProvider(input.provider);
    const stateSecret = createSecret();
    const now = this.now();
    const attempt = await this.persistence.transaction((state) => {
      const intent = resolveAuthIntent(state, input.intent, input.sessionToken, now);
      const attemptId = createStableId('auth_attempt_');
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + (input.ttlMs ?? 10 * 60 * 1_000)).toISOString();
      state.humanAuthAttempts[attemptId] = {
        attemptId,
        provider: input.provider,
        stateDigest: digestSecret(stateSecret),
        intent,
        redirectUri: this.humanAuthRedirectUri,
        createdAt,
        expiresAt,
      };
      return { attemptId, expiresAt };
    });
    return {
      ...attempt,
      provider: input.provider,
      state: stateSecret,
      authorizationUrl: provider.authorizationUrl({ state: stateSecret, redirectUri: this.humanAuthRedirectUri }),
    };
  }

  async completeHumanAuth(input: { provider: HumanAuthProviderId; state: string; code: string; ttlMs?: number }) {
    const provider = this.requireReadyProvider(input.provider);
    const before = this.persistence.snapshot();
    const attempt = findAuthAttempt(before, input.provider, input.state);
    validatePendingAttempt(attempt, this.now());
    const identity = await provider.authenticate({ code: input.code, redirectUri: attempt.redirectUri });
    validateExternalIdentity(identity);
    const completionToken = createSecret();
    return this.persistence.transaction((state) => {
      const currentAttempt = findAuthAttempt(state, input.provider, input.state);
      const now = this.now();
      validatePendingAttempt(currentAttempt, now);
      const result = applyAuthenticatedIdentity(state, currentAttempt.intent, input.provider, identity, now);
      currentAttempt.consumedAt = new Date(now).toISOString();
      const completionId = createStableId('auth_completion_');
      state.humanAuthCompletions[completionId] = {
        completionId,
        tokenDigest: digestSecret(completionToken),
        sessionId: createStableId('session_'),
        humanId: result.human.humanId,
        ...(result.collectiveId ? { collectiveId: result.collectiveId } : {}),
        expiresAt: new Date(now + (input.ttlMs ?? 5 * 60 * 1_000)).toISOString(),
      };
      return {
        completionId,
        completionToken,
        human: result.human,
        ...(result.collectiveId ? { collectiveId: result.collectiveId } : {}),
      };
    });
  }

  async exchangeHumanAuthCompletion(completionToken: string) {
    return this.persistence.transaction((state) => {
      const completion = Object.values(state.humanAuthCompletions).find((candidate) =>
        secretMatches(completionToken, candidate.tokenDigest),
      );
      if (!completion) {
        throw new CollectiveServiceError('AUTH_COMPLETION_INVALID', 'Human auth completion is invalid', 401);
      }
      if (completion.consumedAt) {
        throw new CollectiveServiceError('AUTH_COMPLETION_CONSUMED', 'Human auth completion was already consumed', 409);
      }
      const now = this.now();
      if (Date.parse(completion.expiresAt) < now) {
        throw new CollectiveServiceError('AUTH_COMPLETION_EXPIRED', 'Human auth completion expired', 410);
      }
      const human = state.humans[completion.humanId];
      if (!human) {
        throw new CollectiveServiceError('AUTH_COMPLETION_INVALID', 'Human auth completion is invalid', 401);
      }
      const sessionToken = createSecret();
      state.sessions[completion.sessionId] = {
        sessionId: completion.sessionId,
        humanId: human.humanId,
        tokenDigest: digestSecret(sessionToken),
        createdAt: new Date(now).toISOString(),
      };
      completion.consumedAt = new Date(now).toISOString();
      return {
        human,
        sessionToken,
        ...(completion.collectiveId ? { collectiveId: completion.collectiveId } : {}),
      };
    });
  }

  async joinInvite(input: { inviteToken: string; displayName: string }) {
    requiredIdentityLabel(input.displayName, 'displayName');
    throw new CollectiveServiceError(
      'HUMAN_AUTH_REQUIRED',
      'Authenticate a Human identity before accepting an invite',
      401,
    );
  }

  private requireReadyProvider(providerId: HumanAuthProviderId): HumanAuthProvider {
    const provider = this.humanAuthProvider;
    if (!provider || provider.id !== providerId || !provider.readiness.ready) {
      throw new CollectiveServiceError('AUTH_PROVIDER_NOT_READY', 'Human auth provider is not configured', 503);
    }
    return provider;
  }
}

export function resolveSession(state: ServiceState, sessionToken: string): AuthenticatedHuman {
  const session = Object.values(state.sessions).find((candidate) => secretMatches(sessionToken, candidate.tokenDigest));
  const human = session ? state.humans[session.humanId] : undefined;
  if (!session || !human) {
    throw new CollectiveServiceError('AUTHENTICATION_REQUIRED', 'A valid human session is required', 401);
  }
  return { human, session };
}

export function requireHumanAuthBinding(state: ServiceState, humanId: string) {
  const binding = findHumanAuthBinding(state, humanId);
  if (!binding) {
    throw new CollectiveServiceError(
      'HUMAN_AUTH_REQUIRED',
      'Bind an authenticated Human identity before using the Collective',
      401,
    );
  }
  return binding;
}

function findHumanAuthBinding(state: ServiceState, humanId: string) {
  return Object.values(state.humanAuthBindings).find((binding) => binding.humanId === humanId);
}

export function requireMembership(state: ServiceState, collectiveId: string, humanId: string): MembershipRecord {
  if (!state.collectives[collectiveId]) {
    throw new CollectiveServiceError('COLLECTIVE_NOT_FOUND', 'Collective was not found', 404);
  }
  const membership = state.memberships[membershipKey(collectiveId, humanId)];
  if (!membership) {
    throw new CollectiveServiceError('FORBIDDEN', 'Collective membership is required', 403);
  }
  return membership;
}

export function requireSteward(state: ServiceState, collectiveId: string, humanId: string): MembershipRecord {
  const membership = requireMembership(state, collectiveId, humanId);
  if (membership.role !== 'steward') {
    throw new CollectiveServiceError('FORBIDDEN', 'Collective steward authority is required', 403);
  }
  return membership;
}

function resolveAuthIntent(
  state: ServiceState,
  intent: BeginHumanAuthIntent,
  sessionToken: string | undefined,
  now: number,
): HumanAuthIntent {
  if (intent.kind === 'bind') {
    if (!sessionToken) {
      throw new CollectiveServiceError('AUTHENTICATION_REQUIRED', 'A Human session is required to bind identity', 401);
    }
    return { kind: 'bind', humanId: resolveSession(state, sessionToken).human.humanId };
  }
  if (intent.kind === 'login') return intent;
  const invite = Object.values(state.invites).find((candidate) =>
    secretMatches(intent.inviteToken, candidate.tokenDigest),
  );
  validateInvite(invite, now);
  return { kind: 'accept_invite', inviteId: invite.inviteId };
}
