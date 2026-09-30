import type { AgentKeyFailureReason } from './agent-key-reasons.js';
import type { CatId } from './ids.js';

/**
 * Which authorization boundary a key belongs to. `cloud-conversation` keys are issued by the Host for a
 * cloud cat (F202 W2-3 h3c-2): whatever the cat configuration says later, such a key is only ever
 * accepted inside the cloud return boundary, never as an ordinary agent key.
 */
export type AgentKeyScope = 'user-bound' | 'cloud-conversation';

export interface AgentKeyRecord {
  agentKeyId: string;
  catId: CatId;
  userId: string;
  secretHash: string;
  salt: string;
  scope: AgentKeyScope;
  issuedAt: number;
  expiresAt: number;
  rotatedFrom?: string;
  graceUntil?: number;
  lastUsedAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type AgentKeyVerifyResult = { ok: true; record: AgentKeyRecord } | { ok: false; reason: AgentKeyFailureReason };
