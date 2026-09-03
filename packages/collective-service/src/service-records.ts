import type { CollectiveEventEnvelope } from '@cat-cafe/shared';

import type { HumanAuthAttemptRecord, HumanAuthBindingRecord, HumanAuthCompletionRecord } from './human-auth-state.js';

export interface HumanRecord {
  readonly humanId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly humanId: string;
  readonly tokenDigest: string;
  readonly createdAt: string;
}

export interface CollectiveRecord {
  readonly collectiveId: string;
  readonly name: string;
  readonly createdByHumanId: string;
  readonly createdAt: string;
}

export interface MembershipRecord {
  readonly collectiveId: string;
  readonly humanId: string;
  readonly role: 'steward' | 'member';
  readonly joinedAt: string;
}

export interface InviteRecord {
  readonly inviteId: string;
  readonly collectiveId: string;
  readonly tokenDigest: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

export interface PairingIntentRecord {
  readonly pairingIntentId: string;
  readonly collectiveId: string;
  readonly createdByHumanId: string;
  readonly hostOrigin: string;
  readonly nonceDigest: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

export interface ConnectionRecord {
  readonly connectionId: string;
  readonly collectiveId: string;
  readonly endpointId: string;
  readonly endpointLabel: string;
  readonly credentialDigest: string;
  readonly authorizedHumanId?: string;
  readonly status: 'connected' | 'revoked';
  readonly revocationReason?: 'owner_revoked' | 'self_revoked' | 'identity_rebind_required';
  readonly lastDeliveredSequence: number;
  readonly lastAckedSequence: number;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface ServiceState {
  readonly schemaVersion: 2;
  readonly serviceInstanceId: string;
  readonly createdAt: string;
  readonly bootstrap: {
    readonly tokenDigest: string;
    readonly expiresAt: string;
    readonly consumedAt?: string;
    readonly ownerHumanId?: string;
  };
  readonly humans: Record<string, HumanRecord>;
  readonly sessions: Record<string, SessionRecord>;
  readonly humanAuthBindings: Record<string, HumanAuthBindingRecord>;
  readonly humanAuthAttempts: Record<string, HumanAuthAttemptRecord>;
  readonly humanAuthCompletions: Record<string, HumanAuthCompletionRecord>;
  readonly collectives: Record<string, CollectiveRecord>;
  readonly memberships: Record<string, MembershipRecord>;
  readonly invites: Record<string, InviteRecord>;
  readonly pairingIntents: Record<string, PairingIntentRecord>;
  readonly connections: Record<string, ConnectionRecord>;
  readonly events: Record<string, CollectiveEventEnvelope[]>;
  readonly legacyEvents: Record<string, unknown[]>;
  readonly clientEventIndex: Record<string, string>;
}

export type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

export type MutableServiceState = DeepMutable<ServiceState>;
