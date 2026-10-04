import type { VerifiedAgent } from './state.js';

export interface CollectiveConnectorOptions {
  readonly dataDirectory: string;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}
