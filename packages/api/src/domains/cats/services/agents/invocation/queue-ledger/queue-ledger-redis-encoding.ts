/** Redis cjson loses the array shape of empty tables; preserve the ledger's schema arrays. */
export const ENCODE_QUEUE_ROW_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  encoded = string.gsub(encoded, '"claimedTargetIds":{}', '"claimedTargetIds":[]')
  encoded = string.gsub(encoded, '"requestedTargetCats":{}', '"requestedTargetCats":[]')
  encoded = string.gsub(encoded, '"routingHeldTargetIds":{}', '"routingHeldTargetIds":[]')
  return encoded
end
`;
