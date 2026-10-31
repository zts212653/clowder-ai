import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import type { AgentKeyRegistry } from '../../agents/agent-key/AgentKeyRegistry.js';
import type { DotConnectionStore } from './DotConnectionStore.js';
import { DOT_CAT_ID, type DotConnectionState, projectDotConnection } from './dot-connection-state.js';
import { type DotWebhookSend, verifyDotWebhook } from './dot-webhook.js';

export interface DotConnectionAuthority {
  ownerUserId: string;
  pluginInstanceId: string;
}
export class DotConnectionService {
  constructor(
    private readonly options: {
      store: DotConnectionStore;
      keys: Pick<AgentKeyRegistry, 'issue' | 'verify' | 'revoke'>;
      authority: () => Promise<DotConnectionAuthority | null>;
      ensureIdentity: () => Promise<void>;
      sendWebhook?: DotWebhookSend;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  current() {
    return this.options.store.read();
  }

  async status(ownerUserId?: string) {
    const authority = await this.options.authority();
    if (ownerUserId !== undefined && authority && ownerUserId !== authority.ownerUserId)
      throw new Error('dot_owner_mismatch');
    const record = await this.options.store.read();
    const credential = record ? await this.options.keys.verify(record.credentialSecret) : null;
    const state =
      authority &&
      record?.ownerUserId === authority.ownerUserId &&
      record.pluginInstanceId === authority.pluginInstanceId
        ? record
        : null;
    return {
      installed: authority !== null,
      credentialActive: credential?.ok === true && state !== null && state.revokedAt === null,
      ...projectDotConnection(
        credential?.ok ? state : state ? { ...state, revokedAt: state.revokedAt ?? this.now() } : null,
        this.now(),
      ),
    };
  }

  async begin(ownerUserId: string, reconnect = false) {
    const authority = await this.requireAuthority(ownerUserId);
    await this.options.ensureIdentity();
    return this.options.store.update(async (previous) => {
      if (previous && previous.ownerUserId !== ownerUserId) throw new Error('dot_owner_mismatch');
      if (
        !reconnect &&
        previous?.pluginInstanceId === authority.pluginInstanceId &&
        previous.revokedAt === null &&
        (previous.pairingExpiresAt > this.now() || previous.pairedAt !== null) &&
        (await this.options.keys.verify(previous.credentialSecret)).ok
      ) {
        return { state: previous, result: this.connectionInstructions(previous) };
      }
      if (previous) await this.options.keys.revoke(previous.agentKeyId, 'dot_reconnection');
      if ((await this.requireAuthority(ownerUserId)).pluginInstanceId !== authority.pluginInstanceId)
        throw new Error('dot_stale_installation');
      const credential = await this.options.keys.issue(createCatId(DOT_CAT_ID), ownerUserId, { expiresAt: null });
      const state: DotConnectionState = {
        v: 1,
        revision: (previous?.revision ?? 0) + 1,
        ownerUserId,
        pluginInstanceId: authority.pluginInstanceId,
        agentKeyId: credential.agentKeyId,
        credentialSecret: credential.secret,
        attemptId: randomUUID(),
        pairingCode: randomBytes(16).toString('hex'),
        pairingExpiresAt: this.now() + 30 * 60_000,
        pairedAt: null,
        pairedCallbackUrl: null,
        subscription: null,
        lastSourceReadAt: null,
        lastReplyAt: null,
        lastImageAt: null,
        revokedAt: null,
        testEventIds: [],
      };
      return { state, result: this.connectionInstructions(state) };
    });
  }

  async authenticate(secret: string): Promise<DotConnectionState> {
    const verified = await this.options.keys.verify(secret);
    if (!verified.ok || verified.record.catId !== DOT_CAT_ID) throw new Error('dot_credential_rejected');
    const state = await this.options.store.read();
    const authority = await this.requireAuthority(verified.record.userId);
    if (
      !state ||
      state.revokedAt !== null ||
      state.agentKeyId !== verified.record.agentKeyId ||
      state.pluginInstanceId !== authority.pluginInstanceId ||
      state.ownerUserId !== authority.ownerUserId
    ) {
      throw new Error('dot_credential_rejected');
    }
    return state;
  }

  /** Shared MCP proves the account connection, not which provider conversation is calling. */
  async verifySharedPrincipal(secret: string): Promise<string> {
    const verified = await this.options.keys.verify(secret);
    if (!verified.ok || verified.record.catId !== 'gpt-pro') throw new Error('shared_connection_rejected');
    return verified.record.userId;
  }

  async authenticateSharedConnection(secret: string): Promise<DotConnectionState> {
    const owner = await this.verifySharedPrincipal(secret);
    const authority = await this.requireAuthority(owner);
    const state = await this.options.store.read();
    if (!state || state.ownerUserId !== owner || state.pluginInstanceId !== authority.pluginInstanceId)
      throw new Error('dot_shared_owner_mismatch');
    // The internal dot key is never returned to Remote; the same source-bound services use it here.
    return this.authenticate(state.credentialSecret);
  }

  async subscribe(
    secret: string,
    input: {
      attemptId: string;
      pairingCode: string;
      url: string;
      secret: string;
      ttlMs?: number | null;
    },
  ) {
    const authenticated = await this.authenticate(secret);
    return this.options.store.update(async (state) => {
      this.assertAttempt(state, authenticated);
      if (!state || input.attemptId !== state.attemptId) throw new Error('dot_attempt_mismatch');
      const pairedTarget = state.pairedCallbackUrl ?? state.subscription?.url;
      if (pairedTarget && pairedTarget !== input.url) throw new Error('dot_repair_required');
      const supplied = Buffer.from(input.pairingCode);
      const expected = Buffer.from(state.pairingCode);
      const sameSubscription = state.subscription?.url === input.url && state.pairedAt !== null;
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected) ||
        (!sameSubscription && state.pairingExpiresAt <= this.now())
      )
        throw new Error('dot_pairing_expired_or_mismatched');
      const id = `dot_${createHash('sha256')
        .update(JSON.stringify([state.ownerUserId, state.agentKeyId, state.attemptId, input.url]))
        .digest('hex')}`;
      const lifetime = input.ttlMs === null ? null : Math.min(input.ttlMs ?? 24 * 60 * 60_000, 7 * 24 * 60 * 60_000);
      if (lifetime !== null && (!Number.isSafeInteger(lifetime) || lifetime <= 0))
        throw new Error('dot_invalid_subscription_ttl');
      const prior = state.subscription;
      const verificationCached =
        prior?.url === input.url && prior.secret === input.secret && prior.verifiedAt > this.now() - 5 * 60_000;
      if (!verificationCached) await verifyDotWebhook(input.url, id, input.secret, this.options.sendWebhook);
      if ((await this.requireAuthority(state.ownerUserId)).pluginInstanceId !== state.pluginInstanceId)
        throw new Error('dot_stale_installation');
      const expiresAt = lifetime === null ? null : this.now() + lifetime;
      const next = {
        ...state,
        revision: state.revision + 1,
        pairedAt: this.now(),
        pairedCallbackUrl: input.url,
        subscription: {
          id,
          url: input.url,
          secret: input.secret,
          expiresAt,
          verifiedAt: verificationCached ? prior!.verifiedAt : this.now(),
          previousSecret:
            prior?.url === input.url && prior.secret !== input.secret ? prior.secret : (prior?.previousSecret ?? null),
          rotationUntil:
            prior?.url === input.url && prior.secret !== input.secret
              ? this.now() + 5 * 60_000
              : (prior?.rotationUntil ?? null),
        },
      };
      return {
        state: next,
        result: {
          id,
          refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(),
          cursor: null,
          truncated: false,
        },
      };
    });
  }

  async unsubscribe(secret: string, url: string, attemptId: string) {
    const authenticated = await this.authenticate(secret);
    return this.options.store.update(async (state) => {
      this.assertAttempt(state, authenticated);
      if (!state || state.attemptId !== attemptId) throw new Error('dot_attempt_mismatch');
      if (state.subscription && state.subscription.url !== url) throw new Error('dot_subscription_mismatch');
      return {
        state: {
          ...state,
          pairedCallbackUrl: state.pairedCallbackUrl ?? state.subscription?.url ?? null,
          revision: state.revision + 1,
          subscription: null,
          pairedAt: null,
        },
        result: {},
      };
    });
  }

  async disconnect(ownerUserId: string) {
    await this.requireAuthority(ownerUserId);
    return this.options.store.update(async (state) => {
      if (!state || state.ownerUserId !== ownerUserId) throw new Error('dot_owner_mismatch');
      await this.options.keys.revoke(state.agentKeyId, 'dot_disconnected');
      return { state: { ...state, revision: state.revision + 1, revokedAt: this.now() }, result: {} };
    });
  }

  async recordEvidence(authenticated: DotConnectionState, kind: 'read' | 'reply' | 'image') {
    await this.authenticate(authenticated.credentialSecret);
    return this.options.store.update(async (state) => {
      this.assertAttempt(state, authenticated);
      if (!state) throw new Error('dot_stale_connection');
      const field = kind === 'read' ? 'lastSourceReadAt' : kind === 'reply' ? 'lastReplyAt' : 'lastImageAt';
      return { state: { ...state, revision: state.revision + 1, [field]: this.now() }, result: undefined };
    });
  }

  async setOwnerPreferences(ownerUserId: string, preferences: { testEventIds?: string[] }, expectedAttemptId?: string) {
    const authority = await this.requireAuthority(ownerUserId);
    return this.options.store.update(async (state) => {
      if (
        !state ||
        state.ownerUserId !== ownerUserId ||
        state.pluginInstanceId !== authority.pluginInstanceId ||
        state.revokedAt !== null ||
        (expectedAttemptId !== undefined && state.attemptId !== expectedAttemptId)
      )
        throw new Error('dot_stale_connection');
      return { state: { ...state, ...preferences, revision: state.revision + 1 }, result: undefined };
    });
  }

  private async requireAuthority(ownerUserId: string) {
    const authority = await this.options.authority();
    if (!authority || authority.ownerUserId !== ownerUserId) throw new Error('dot_installation_or_owner_unavailable');
    return authority;
  }

  private assertAttempt(state: DotConnectionState | null, authenticated: DotConnectionState) {
    if (
      !state ||
      state.revokedAt !== null ||
      state.attemptId !== authenticated.attemptId ||
      state.agentKeyId !== authenticated.agentKeyId
    )
      throw new Error('dot_stale_connection');
  }

  private connectionInstructions(state: DotConnectionState) {
    return {
      ...projectDotConnection(state, this.now()),
      credentialSecret: state.credentialSecret,
      instructions: `订阅猫咖的 dot.summoned 事件，attempt_id 为 ${state.attemptId}，pairing_code 为 ${state.pairingCode}。收到召唤后读取原消息，并在原对话回复；不另行通知我。`,
    };
  }
}
