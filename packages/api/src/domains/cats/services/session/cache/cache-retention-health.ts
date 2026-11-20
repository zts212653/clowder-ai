/** Facts are immutable by invocation; replay canonical input order so late billing cannot lose health. */
export const RECORD_RETENTION_RETURN = `
local incoming = cjson.decode(ARGV[2])
local facts = {}
local duplicate = false
for _, raw in ipairs(redis.call('HVALS', KEYS[2])) do
  local fact = cjson.decode(raw)
  if fact.invocationId == incoming.invocationId then
    if fact.inputSequence ~= incoming.inputSequence or fact.observedAt ~= incoming.observedAt
      or fact.readRatio ~= incoming.readRatio then return 0 end
    duplicate = true
  elseif fact.inputSequence == incoming.inputSequence then return 0 end
  table.insert(facts, fact)
end
if not duplicate then table.insert(facts, incoming) end
table.sort(facts, function(a, b) return a.inputSequence < b.inputSequence end)
local health = {consecutiveCold=0, stopped=false}
for _, fact in ipairs(facts) do
  health.lastInvocationId = fact.invocationId
  health.lastObservedAt = fact.observedAt
  if fact.readRatio ~= nil then
    if fact.readRatio < 0.95 then health.consecutiveCold = health.consecutiveCold + 1
    else health.consecutiveCold = 0 end
  end
  if health.consecutiveCold >= 2 then health.stopped = true end
end
if not duplicate then redis.call('HSET', KEYS[2], ARGV[1], ARGV[2]) end
redis.call('SET', KEYS[1], cjson.encode(health))
return 1
`;
