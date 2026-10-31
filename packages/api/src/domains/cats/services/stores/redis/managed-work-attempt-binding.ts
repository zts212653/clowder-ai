import type { CatId, WorkAdmission, WorkAttempt, WorkflowSopAdmissionBundle } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ManagedWorkExecutorConflictError } from '../ports/WorkflowSopStore.js';
import { deriveWorkflowSopAdmissionIds, ManagedWorkKeys } from '../redis-keys/managed-work-keys.js';

/**
 * Atomically bind the reserved first attempt to one authenticated executor.
 * Missing admission is ordinary/unmanaged. Partial or mismatched identity and
 * a different executor fail closed.
 */
const BIND_ATTEMPT_LUA = `
local admissionRaw = redis.call('GET', KEYS[1])
local attemptRaw = redis.call('GET', KEYS[2])
if not admissionRaw and not attemptRaw then
  return {'not_admitted'}
end
if not admissionRaw or not attemptRaw then
  return {'identity_conflict', 'partial_identity_bundle'}
end

local admission = cjson.decode(admissionRaw)
local attempt = cjson.decode(attemptRaw)
if admission.workId ~= ARGV[2]
  or admission.ownerUserId ~= ARGV[1]
  or admission.producerKind ~= 'workflow_sop_v1'
  or admission.producerRef ~= ARGV[3]
  or admission.initialAttemptId ~= ARGV[4]
  or attempt.attemptId ~= ARGV[4]
  or attempt.workId ~= ARGV[2]
  or attempt.attemptNumber ~= 1 then
  return {'identity_conflict', 'identity_mismatch'}
end

if attempt.executorCatId == nil or attempt.executorCatId == cjson.null then
  attempt.executorCatId = ARGV[5]
  attempt.executorBoundAt = tonumber(ARGV[6])
  attemptRaw = cjson.encode(attempt)
  redis.call('SET', KEYS[2], attemptRaw)
  return {'bound', admissionRaw, attemptRaw}
end
if attempt.executorCatId == ARGV[5] then
  return {'same', admissionRaw, attemptRaw}
end
return {'executor_conflict', attempt.executorCatId}
`;

export async function bindManagedWorkAttemptInRedis(input: {
  redis: RedisClient;
  ownerUserId: string;
  backlogItemId: string;
  executorCatId: CatId;
}): Promise<WorkflowSopAdmissionBundle | null> {
  const authenticatedOwnerUserId = input.ownerUserId.trim();
  if (authenticatedOwnerUserId.length === 0) {
    throw new Error('Managed-work attempt bind requires authenticated ownerUserId');
  }
  const executor = String(input.executorCatId).trim();
  if (executor.length === 0) throw new Error('Managed-work attempt bind requires executorCatId');

  const { workId, attemptId } = deriveWorkflowSopAdmissionIds(authenticatedOwnerUserId, input.backlogItemId);
  const result = (await input.redis.eval(
    BIND_ATTEMPT_LUA,
    2,
    ManagedWorkKeys.admission(workId),
    ManagedWorkKeys.attempt(attemptId),
    authenticatedOwnerUserId,
    workId,
    input.backlogItemId,
    attemptId,
    executor,
    String(Date.now()),
  )) as unknown;

  if (!Array.isArray(result) || typeof result[0] !== 'string') {
    throw new Error('Unexpected managed-work attempt bind result');
  }
  if (result[0] === 'not_admitted') return null;
  if (result[0] === 'executor_conflict' && typeof result[1] === 'string') {
    throw new ManagedWorkExecutorConflictError(result[1] as CatId);
  }
  if (result[0] === 'identity_conflict') {
    throw new Error(`Managed-work attempt bind failed closed: ${String(result[1] ?? 'unknown')}`);
  }
  if (
    (result[0] !== 'bound' && result[0] !== 'same') ||
    typeof result[1] !== 'string' ||
    typeof result[2] !== 'string'
  ) {
    throw new Error(`Unexpected managed-work attempt bind result: ${String(result[0])}`);
  }

  return {
    admission: JSON.parse(result[1]) as WorkAdmission,
    attempt: JSON.parse(result[2]) as WorkAttempt,
  };
}
