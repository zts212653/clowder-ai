import type { CatId } from '@cat-cafe/shared';
import type { AgentAccessOpenCodeEvent } from '@clowder-ai/agent-contract';
import { excerptSanitizedStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import type { AgentMessage } from '../../types.js';

/**
 * Wire event → the Host's `AgentMessage`.
 *
 * The package already decided *what* each raw event means; this mapping only adds
 * what requires being the Host: the `catId` stamp, error-text sanitisation, and the
 * message types consumers switch on. Keeping it separate is what lets the package
 * stay standalone — it never imports these types.
 */
export function mapOpenCodeWireEvent(event: AgentAccessOpenCodeEvent, catId: CatId | string): AgentMessage | null {
  const cast = catId as CatId;

  switch (event.kind) {
    case 'ignored':
      return null;

    case 'session_init':
      return { type: 'session_init', catId: cast, sessionId: event.sessionId, timestamp: event.timestamp };

    case 'text':
      return { type: 'text', catId: cast, content: event.text, timestamp: event.timestamp };

    case 'thinking':
      return {
        type: 'system_info',
        catId: cast,
        content: JSON.stringify({ type: 'thinking', text: event.text }),
        timestamp: event.timestamp,
      };

    case 'tool':
      return {
        type: 'tool_use',
        catId: cast,
        toolName: event.name,
        ...(event.input ? { toolInput: event.input } : {}),
        timestamp: event.timestamp,
      };

    case 'usage':
      // Provider/model placeholders: the service merges its own effective model onto
      // this metadata, and a guessed model here would break downstream normalization.
      return {
        type: 'agent_loop',
        catId: cast,
        timestamp: event.timestamp,
        metadata: { provider: 'opencode', model: '', usage: event.usage },
      };

    case 'error':
      return {
        type: 'error',
        catId: cast,
        error: excerptSanitizedStderr(event.message, { edge: 'head', maxLength: 2048 }),
        timestamp: event.timestamp,
      };
  }
}
