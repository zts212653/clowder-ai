import type { RedisClient } from '@cat-cafe/shared/utils';
import { WRITE_TASK_WITH_RECOVERY } from './deployment-recovery-lua.js';

/** Preserve the existing transaction/watch boundary; canonical Task fields and derived recovery commit together. */
export function publishTaskRecovery(
  transaction: ReturnType<RedisClient['multi']>,
  key: string,
  fields: Record<string, string>,
  deleteFields: readonly string[] = [],
): void {
  transaction.eval(
    WRITE_TASK_WITH_RECOVERY,
    1,
    key,
    JSON.stringify(Object.entries(fields).flatMap(([key, value]) => [key, value ?? ''])),
    JSON.stringify(deleteFields),
  );
}

/** EXEC returning an array does not prove that its commands succeeded. */
export async function commitTaskTransaction(transaction: ReturnType<RedisClient['multi']>) {
  const result = await transaction.exec();
  for (const [error] of result ?? []) if (error) throw error;
  return result;
}
