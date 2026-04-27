import type { AgentKeyRecord, AgentKeyVerifyResult } from '@cat-cafe/shared';

export type AgentKeyInput = Omit<AgentKeyRecord, 'lastUsedAt'>;

export interface IAgentKeyBackend {
  create(input: AgentKeyInput): Promise<void>;
  verify(secret: string): Promise<AgentKeyVerifyResult>;
  get(agentKeyId: string): Promise<AgentKeyRecord | null>;
  list(filter: { catId?: string; userId?: string; includeRevoked?: boolean }): Promise<AgentKeyRecord[]>;
  revoke(agentKeyId: string, reason: string): Promise<boolean>;
  updateGrace(agentKeyId: string, graceUntil: number): Promise<boolean>;
  touchLastUsed(agentKeyId: string, timestamp: number): Promise<void>;
}
