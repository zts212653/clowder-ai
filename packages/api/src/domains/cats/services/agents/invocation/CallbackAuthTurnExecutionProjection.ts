import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { AuthTerminalCommitInput, AuthTerminalDisposition } from './InvocationRegistry.js';

export function callbackAuthDispositionFromTurnExecution(record: TurnExecutionRecord): AuthTerminalDisposition {
  if (record.status === 'running') throw new Error(`TurnExecution ${record.invocationId} is not terminal`);
  return record.status === 'succeeded' ? 'completed' : record.status;
}

export function authTerminalFromTurnExecution(record: TurnExecutionRecord): AuthTerminalCommitInput {
  if (record.status === 'running' || record.endedAt === undefined) {
    throw new Error(`TurnExecution ${record.invocationId} is not terminal`);
  }
  return {
    invocationId: record.invocationId,
    disposition: callbackAuthDispositionFromTurnExecution(record),
    endedAt: record.endedAt,
    endReason: record.terminalReason ?? record.status,
    terminalRef: `turn_execution:${record.invocationId}`,
  };
}
