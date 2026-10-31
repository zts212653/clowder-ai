import type { EntrustedWorkTaskExecutionV1 } from '@cat-cafe/shared';

export type EntrustedWorkHumanTerminalErrorCode =
  | 'HUMAN_TERMINAL_NOT_FOUND'
  | 'HUMAN_TERMINAL_FORBIDDEN'
  | 'HUMAN_TERMINAL_CONTRACT_MISSING'
  | 'HUMAN_TERMINAL_REVISION_CONFLICT'
  | 'HUMAN_TERMINAL_ALREADY_CLOSED'
  | 'HUMAN_TERMINAL_EXECUTION_NOT_IDLE'
  | 'HUMAN_TERMINAL_RECEIPT_CONFLICT'
  | 'HUMAN_TERMINAL_RECEIPT_UNAVAILABLE';

export class EntrustedWorkHumanTerminalError extends Error {
  constructor(
    readonly code: EntrustedWorkHumanTerminalErrorCode,
    message: string,
    readonly execution?: EntrustedWorkTaskExecutionV1,
  ) {
    super(message);
    this.name = 'EntrustedWorkHumanTerminalError';
  }
}
