import type { RedisClient } from '@cat-cafe/shared/utils';
import { hardForgetPersonAtRevision } from './person-memory-forget.js';
import type {
  ExecuteOwnerMemoryActionInput,
  OwnerMemoryActionCommand,
  OwnerMemoryActionExecutionResult,
} from './person-memory-owner-action-contract.js';

export async function hardForgetPersonOwnerAction(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput & {
    command: Extract<OwnerMemoryActionCommand, { action: 'hard_forget_person' }>;
  },
): Promise<OwnerMemoryActionExecutionResult> {
  const result = await hardForgetPersonAtRevision(
    redis,
    {
      ownerUserId: input.ownerUserId,
      personId: input.command.personId,
      requestId: input.command.requestId,
      requestedAt: input.evidence.issuedAt,
    },
    input.command.expectedPersonRevision,
  );
  if (!('receipt' in result)) return { action: input.command.action, outcome: result.outcome };
  return {
    action: input.command.action,
    outcome: result.outcome === 'replayed' ? 'replayed' : 'applied',
    receipt: result.receipt,
  };
}
