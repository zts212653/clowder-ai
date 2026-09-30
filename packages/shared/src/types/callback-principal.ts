import type { AgentKeyScope } from './agent-key.js';
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
      /** A `cloud-conversation` key is only ever accepted inside the cloud return boundary (F202 W2-3 h3c-2). */
      scope: AgentKeyScope;
      /**
       * Whether, when the key was authenticated, it was the configured cloud cat's cloud credential. A
       * route that later finds the configuration changed must refuse, not reinterpret the key.
       */
      cloudBoundary: boolean;
    };
