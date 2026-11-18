import type { A2AJsonRpcResponse } from '@cat-cafe/shared';
import type { AgentAccessA2AEvent, AgentAccessA2ASubmit, AgentAccessA2ATurn } from '@clowder-ai/agent-contract';
import { transformA2ATaskToMessages } from './a2a-event-transform.js';

export async function runA2ATurn(
  input: AgentAccessA2ATurn,
  submit: AgentAccessA2ASubmit,
): Promise<AgentAccessA2AEvent[]> {
  const error = (message: string): AgentAccessA2AEvent => ({
    type: 'error',
    catId: input.catId,
    content: message,
    error: message,
    timestamp: Date.now(),
  });
  const body = {
    jsonrpc: '2.0',
    id: input.taskId,
    method: 'tasks/send',
    params: {
      id: input.taskId,
      message: { role: 'user', parts: [{ type: 'text', text: input.prompt }] },
    },
  };
  const response = await submit(JSON.stringify(body));
  if (response.status < 200 || response.status >= 300)
    return [error(`A2A request failed: ${response.status} ${response.statusText}`)];
  const payload = response.payload as A2AJsonRpcResponse;
  if (payload.error) return [error(`A2A RPC error: ${payload.error.message} (code: ${payload.error.code})`)];
  if (!payload.result) return [error('A2A response missing result')];
  const events = transformA2ATaskToMessages(payload.result, input.catId);
  if (!events.some((event) => event.type === 'done' || event.type === 'error')) {
    events.push(
      error(
        `A2A task status ${payload.result.status} does not confirm successful completion; remote task termination is unconfirmed`,
      ),
    );
  }
  return events;
}
