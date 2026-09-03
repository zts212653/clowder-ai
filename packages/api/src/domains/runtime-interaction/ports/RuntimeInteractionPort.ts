import type {
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';

export interface RuntimeInteractionPort {
  request(request: RuntimeInteractionRequest, options?: { signal?: AbortSignal }): Promise<RuntimeInteractionResponse>;
  invalidateInvocation(invocationId: string, reasonCode: RuntimeInteractionTerminalReasonCode): Promise<unknown>;
}
