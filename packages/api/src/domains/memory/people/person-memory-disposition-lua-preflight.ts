export const PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA = `
local function redis_type_name(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply.ok end
  return reply
end
local function allowed_type(key, expected)
  local actual = redis_type_name(key)
  return actual == 'none' or actual == expected
end
local function finite_number(text)
  local value = tonumber(text)
  if value == nil or value ~= value or value == math.huge or value == -math.huge then return nil end
  return value
end
local function valid_json(raw)
  local ok, value = pcall(cjson.decode, raw)
  return ok and type(value) == 'table'
end
`;
