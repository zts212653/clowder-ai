import type { CollectiveEventEnvelope, CollectivePairingIntent, CollectiveTarget } from '@cat-cafe/shared';

export interface CollectiveMeta {
  readonly serviceInstanceId: string;
  readonly bootstrapNeeded: boolean;
  readonly clientBuildId: string;
}

export interface CollectiveHuman {
  readonly humanId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly createdAt: string;
}

export interface CollectiveHumanAuth {
  readonly provider: 'github';
  readonly handle: string;
}

export interface CollectiveMembership {
  readonly collectiveId: string;
  readonly name: string;
  readonly createdByHumanId: string;
  readonly createdAt: string;
  readonly role: 'steward' | 'member';
}

export interface CollectiveMe {
  readonly human: CollectiveHuman;
  readonly auth: CollectiveHumanAuth | null;
  readonly collectives: readonly CollectiveMembership[];
}

export interface HumanAuthProviderStatus {
  readonly id: 'github';
  readonly ready: boolean;
  readonly reason?: string;
}

export interface HumanAuthBeginResult {
  readonly authorizationUrl: string;
}

export interface ClientTarget {
  readonly target: CollectiveTarget;
  readonly replyToEventId?: string;
}

export interface ChannelThread {
  readonly root: CollectiveEventEnvelope;
  readonly replies: readonly CollectiveEventEnvelope[];
}

export interface InviteResult {
  readonly inviteToken: string;
}

export interface SessionResult {
  readonly sessionToken: string;
}

export type PairingIntentResult = CollectivePairingIntent;

export type ClientPhase = 'loading' | 'entry' | 'bind-identity' | 'create-collective' | 'ready' | 'unavailable';

export type DeliveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting'; readonly label: string }
  | { readonly kind: 'accepted'; readonly label: string }
  | { readonly kind: 'failed'; readonly label: string };

export interface ClientSnapshot {
  readonly phase: ClientPhase;
  readonly meta?: CollectiveMeta;
  readonly me?: CollectiveMe;
  readonly collective?: CollectiveMembership;
  readonly providers: readonly HumanAuthProviderStatus[];
  readonly events: readonly CollectiveEventEnvelope[];
  readonly connection: 'online' | 'offline';
  readonly delivery: DeliveryState;
  readonly notice?: string;
  readonly error?: string;
}

export type { CollectiveEventEnvelope, CollectiveTarget };
