import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { inspectSecretValue } from './secret-runtime.js';
import { recordSecretExposure } from './secret-tool-guard.js';

interface Inspection {
  value: unknown;
  rules: string[];
}

export function blockedMcpReply(message: JSONRPCMessage): JSONRPCMessage | undefined {
  if (!('id' in message) || message.id === undefined || !('method' in message)) return undefined;
  return message.method === 'tools/call'
    ? {
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'secret_content_blocked_before_send' }] },
      }
    : { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'secret_content_blocked_before_send' } };
}

/** Inspect all wire fields, including extension metadata and notifications. */
export async function inspectMcpWire(message: JSONRPCMessage): Promise<Inspection> {
  return inspectSecretValue(message);
}

export async function redactMcpWire(message: JSONRPCMessage, source = 'mcp'): Promise<JSONRPCMessage> {
  const inspected = await inspectMcpWire(message);
  if (inspected.rules.length) {
    try {
      await recordSecretExposure({
        state: 'exposed_or_suspected',
        callId: `${source}:wire:${'id' in message ? message.id : 'notification'}`,
        rules: inspected.rules,
      });
    } catch {
      process.stderr.write(
        'secret_result_redacted: rotation reminder could not be saved; rotate the affected credential.\n',
      );
    }
  }
  return inspected.value as JSONRPCMessage;
}
