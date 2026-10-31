import type { RuntimeInteractionTerminalReasonCode } from '@cat-cafe/shared';

export type RuntimeInteractionErrorCode =
  | 'duplicate'
  | 'not_found'
  | 'unauthorized'
  | 'stale'
  | 'invalid_response'
  | 'unavailable';

export class RuntimeInteractionError extends Error {
  constructor(
    readonly code: RuntimeInteractionErrorCode,
    message: string,
    readonly reasonCode?: RuntimeInteractionTerminalReasonCode,
  ) {
    super(message);
    this.name = 'RuntimeInteractionError';
  }
}
