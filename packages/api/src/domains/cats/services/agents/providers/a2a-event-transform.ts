/**
 * A2A Event Transformer
 * A2A Task/Artifact → Clowder AI AgentMessage 映射
 *
 * Mapping:
 *   Task completed + text artifacts → text messages
 *   Task completed + file artifacts → text (file reference)
 *   Task failed → error message
 *   Task input-required → system_info
 */

import type { A2APart, A2ATask, CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

/** Extract text content from A2A parts */
export function extractTextFromParts(parts: A2APart[]): string {
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n');
}

function msg(type: AgentMessage['type'], catId: CatId, content?: string): AgentMessage {
  return { type, catId, content, timestamp: Date.now() };
}

/** Normalize A2A wire format status (SCREAMING_SNAKE_CASE → lowercase) */
function normalizeStatus(status: string): A2ATask['status'] {
  const map: Record<string, A2ATask['status']> = {
    TASK_STATE_SUBMITTED: 'submitted',
    TASK_STATE_WORKING: 'working',
    TASK_STATE_COMPLETED: 'completed',
    TASK_STATE_FAILED: 'failed',
    TASK_STATE_CANCELED: 'canceled',
    TASK_STATE_INPUT_REQUIRED: 'input-required',
  };
  return map[status] ?? (status.toLowerCase().replace(/_/g, '-') as A2ATask['status']);
}

/** Transform a completed A2A Task into AgentMessage[] */
export function transformA2ATaskToMessages(task: A2ATask, catId: CatId): AgentMessage[] {
  const status = normalizeStatus(task.status);
  const messages: AgentMessage[] = [];

  if (status === 'completed') {
    if (task.artifacts && task.artifacts.length > 0) {
      for (const artifact of task.artifacts) {
        const text = extractTextFromParts(artifact.parts);
        if (text) {
          messages.push(msg('text', catId, text));
        }
        for (const part of artifact.parts) {
          if (part.type === 'file' && part.file) {
            messages.push(msg('text', catId, `[File: ${part.file.name} (${part.file.mimeType})]`));
          }
        }
      }
    }

    // Fallback: use last agent message from history
    if (messages.length === 0 && task.history) {
      const lastAgent = [...task.history].reverse().find((m) => m.role === 'agent');
      if (lastAgent) {
        const text = extractTextFromParts(lastAgent.parts);
        if (text) {
          messages.push(msg('text', catId, text));
        }
      }
    }

    messages.push(msg('done', catId));
  } else if (status === 'failed') {
    messages.push(msg('error', catId, 'A2A task failed'));
  } else if (status === 'input-required') {
    messages.push(msg('system_info', catId, 'A2A agent requires additional input'));
  }

  return messages;
}
