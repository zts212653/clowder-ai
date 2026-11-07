/** Task aggregate extension. These functions run inside the existing owner's guarded writer. */
export const TASK_DEPLOYMENT_RECOVERY_LUA = `
local function recoveryKeys(detail, id)
  local prefix = string.sub(detail, 1, #detail - #id - #'task:')
  return prefix .. 'tasks:deployment-wait:live:due', prefix .. 'tasks:deployment-wait:audit:due'
end
local function recoveryPreflight(detail, id)
  local live, audit = recoveryKeys(detail, id)
  local projection = string.sub(live, 1, #live - #'live:due') .. 'projection'
  local projectionKind = redis.call('TYPE', projection).ok
  if projectionKind ~= 'none' and projectionKind ~= 'set' then error('invalid_deployment_projection_index') end
  for _, key in ipairs({live, audit}) do
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= 'zset' then error('invalid_deployment_recovery_index') end
  end
end
local function recoveryFacts(detail)
  local raw = redis.call('HGET', detail, '_deploymentRecovery')
  if raw then
    local ok, facts = pcall(cjson.decode, raw)
    if ok and type(facts) == 'table' and type(facts.pending) == 'table' then return facts end
    return {pending={}, sourceDisposition='needs_attention', sourceReason='invalid_deployment_recovery', sourceRecoveryRaw=raw}
  end
  return {pending = {}}
end
local function captureAudit(detail, facts, receipt, origin)
  if facts.sourceRecoveryRaw then return end
  local raw = redis.call('HGET', detail, 'deploymentWait')
  if not raw or raw == '' then return end
  local ok, wait = pcall(cjson.decode, raw)
  if not ok or type(wait) ~= 'table' then
    facts.sourceDisposition = 'needs_attention'
    facts.sourceReason = 'invalid_deployment_wait'
    return
  end
  local outcome = wait.waitOutcome
  if type(outcome) ~= 'table' then return end
  if type(outcome.outcomeId) ~= 'string' or type(outcome.subjectRef) ~= 'string'
    or type(outcome.generation) ~= 'number' or type(outcome.at) ~= 'number' or type(outcome.reason) ~= 'string' then
    facts.sourceDisposition = 'needs_attention'; facts.sourceReason = 'invalid_deployment_outcome'; return
  end
  if facts.capturedOutcomeId == outcome.outcomeId then return end
  local id = redis.call('HGET', detail, 'id')
  local event = {v=1, eventId=id .. ':' .. outcome.outcomeId, kind='wait.terminated', waitId=id,
    waitKind='deployment', subjectRef=outcome.subjectRef, generation=outcome.generation,
    reason=outcome.reason, at=outcome.at, actor=outcome.actor or {kind='system'},
    threadId=redis.call('HGET', detail, 'threadId') or '',
    ownerUserId=redis.call('HGET', detail, 'userId') or '', ownerCatId=redis.call('HGET', detail, 'ownerCatId') or ''}
  local needsOriginal = outcome.reason == 'owner_changed' or outcome.reason == 'subject_terminal'
  local knownOwner = not needsOriginal and event.ownerUserId ~= '' and event.ownerCatId ~= '' and event.threadId ~= ''
  if receipt and receipt.proofKind == 'deployment_predicate' and receipt.taskId == id
    and receipt.subjectRef == outcome.subjectRef and receipt.generation == outcome.generation then
    event.threadId = receipt.threadId
    event.ownerUserId = receipt.userId
    event.ownerCatId = receipt.catId
    knownOwner = true
  elseif needsOriginal and origin and origin.generation == outcome.generation and origin.subjectRef == outcome.subjectRef
    and origin.ownerCatId ~= '' and origin.ownerUserId ~= '' and origin.threadId ~= '' then
    event.threadId = origin.threadId; event.ownerUserId = origin.ownerUserId; event.ownerCatId = origin.ownerCatId
    knownOwner = true
  end
  if not knownOwner then event.ownerCatId = '' end
  if not facts.pending[event.eventId] then
    local entry = {taskId=id, event=event, token=redis.sha1hex(cjson.encode(event)), failures=0, nextAt=outcome.at}
    if not knownOwner then entry.disposition = 'needs_attention'; entry.reasonCode = 'original_wait_owner_unknown' end
    facts.pending[event.eventId] = entry
  end
  facts.capturedOutcomeId = outcome.outcomeId
end
local function projectRecovery(detail, id, facts)
  local liveKey, auditKey = recoveryKeys(detail, id)
  local projection = string.sub(liveKey, 1, #liveKey - #'live:due') .. 'projection'
  if facts.live then redis.call('SADD', projection, id) else redis.call('SREM', projection, id) end
  if facts.live and not facts.live.disposition then redis.call('ZADD', liveKey, facts.live.nextAt, id)
  else redis.call('ZREM', liveKey, id) end
  local auditAt = nil
  for _, entry in pairs(facts.pending) do
    if not entry.disposition and (not auditAt or entry.nextAt < auditAt) then auditAt = entry.nextAt end
  end
  if auditAt then redis.call('ZADD', auditKey, auditAt, id) else redis.call('ZREM', auditKey, id) end
  redis.call('HSET', detail, '_deploymentRecovery', cjson.encode(facts))
end
local function writeTaskRecovery(detail, fields)
  local id = redis.call('HGET', detail, 'id')
  for i=1,#fields,2 do if fields[i] == 'id' then id = fields[i+1] end end
  if not id then error('task_recovery_missing_identity') end
  local hasWait = (redis.call('HGET', detail, 'deploymentWait') or '') ~= ''
  for i=1,#fields,2 do if fields[i] == 'deploymentWait' and fields[i+1] ~= '' then hasWait = true end end
  if not hasWait and not redis.call('HGET', detail, '_deploymentRecovery') then
    if #fields > 0 then redis.call('HSET', detail, unpack(fields)) end
    return
  end
  recoveryPreflight(detail, id)
  local facts = recoveryFacts(detail)
  local receiptRaw = redis.call('HGET', detail, 'typedWaitRegistration')
  local receipt = nil
  if receiptRaw and receiptRaw ~= '' then receipt = cjson.decode(receiptRaw) end
  local origin = nil
  local previousRaw = redis.call('HGET', detail, 'deploymentWait') or ''
  local previousOk, previousWait = pcall(cjson.decode, previousRaw)
  if previousOk and type(previousWait) == 'table' then
    local anchor = previousWait.await or (previousWait.waitOutcome and previousWait.waitOutcome.reason == 'matched' and previousWait.waitOutcome)
    if anchor then origin = {generation=anchor.generation, subjectRef=anchor.subjectRef,
      threadId=redis.call('HGET', detail, 'threadId') or '', ownerUserId=redis.call('HGET', detail, 'userId') or '',
      ownerCatId=redis.call('HGET', detail, 'ownerCatId') or ''} end
  end
  captureAudit(detail, facts, receipt, nil)
  if #fields > 0 then redis.call('HSET', detail, unpack(fields)) end
  captureAudit(detail, facts, receipt, origin)
  local raw = redis.call('HGET', detail, 'deploymentWait') or ''
  local ok, wait = pcall(cjson.decode, raw)
  local live = ok and type(wait) == 'table' and
    (wait.await or wait.currentExecutionClaim or (wait.waitOutcome and wait.waitOutcome.reason == 'matched' and wait.waitOutcome.delivery == 'pending'))
    and redis.call('HGET', detail, 'kind') == 'work' and redis.call('HGET', detail, 'status') ~= 'done'
    and (redis.call('HGET', detail, 'ownerCatId') or '') ~= '' and (redis.call('HGET', detail, 'userId') or '') ~= ''
  if live and not facts.sourceDisposition then
    if not facts.live or facts.live.signature ~= raw then
      facts.live = {signature=raw, failures=0, nextAt=tonumber(redis.call('HGET', detail, 'updatedAt')) or 0}
    end
  else facts.live = nil end
  -- Tasks with no deployment history do not acquire recovery metadata or index dependencies.
  if raw ~= '' or next(facts.pending) or facts.capturedOutcomeId then projectRecovery(detail, id, facts) end
end
`;

export const WRITE_TASK_WITH_RECOVERY = `-- TASK_PUBLISH_WITH_RECOVERY
${TASK_DEPLOYMENT_RECOVERY_LUA}
writeTaskRecovery(KEYS[1], cjson.decode(ARGV[1]))
local removed = cjson.decode(ARGV[2])
if #removed > 0 then redis.call('HDEL', KEYS[1], unpack(removed)) end
return 1`;
