import type { RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import type { RichCardBlock } from '@/stores/chat-types';

export const messageId = 'message-runtime';
export const block: RichCardBlock = {
  id: 'runtime-interaction:interaction-ui',
  kind: 'card',
  v: 1,
  title: 'Runtime interaction',
  tone: 'warning',
  meta: { kind: 'runtime_interaction', interactionId: 'interaction-ui', interactionKind: 'approval' },
};

export const owner = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-ui' };
export const provider = {
  providerId: 'openai',
  method: 'item/commandExecution/requestApproval',
  requestId: 'rpc-ui',
  threadId: 'provider-thread',
  turnId: 'provider-turn',
  itemId: 'provider-item',
};
export const cardRef = { threadId: 'thread-1', messageId, blockId: block.id };

export function approvalRequest(): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId: 'interaction-ui',
    kind: 'approval',
    owner,
    provider,
    createdAt: 1000,
    title: 'Run tests?',
    description: 'pnpm test',
    decisions: [
      { id: 'accept', label: 'Allow once', outcome: 'accept' },
      { id: 'accept-session', label: 'Allow this session', outcome: 'accept' },
      { id: 'decline', label: 'Decline', outcome: 'decline' },
      { id: 'cancel', label: 'Cancel turn', outcome: 'cancel' },
    ],
  };
}

export function record(
  request: RuntimeInteractionRequest,
  status: RuntimeInteractionRecord['status'] = 'pending',
  terminal?: RuntimeInteractionRecord['terminal'],
): RuntimeInteractionRecord {
  return {
    request,
    status,
    hostEpoch: 'host-ui',
    cardRef,
    ...(terminal ? { terminal } : {}),
    updatedAt: 2000,
  };
}

export function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

export function errorJson(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as Response;
}

export function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
