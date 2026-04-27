import type { CatId } from './ids.js';

export type CallbackPrincipal =
  | {
      kind: 'invocation';
      invocationId: string;
      parentInvocationId?: string;
      threadId: string;
      userId: string;
      catId: CatId;
    }
  | {
      kind: 'agent_key';
      agentKeyId: string;
      userId: string;
      catId: CatId;
      scope: 'user-bound';
    };
