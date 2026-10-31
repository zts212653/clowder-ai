import type { AuthStrategy, AuthType } from '../types.js';
import { apikeyStrategy, queryParamStrategy } from './apikey.js';
import { hmacSha256V4Strategy } from './hmac-sha256-v4.js';
import { jwtHs256Strategy } from './jwt-hs256.js';

const strategies = new Map<AuthType, AuthStrategy>([
  ['apikey', apikeyStrategy],
  ['query-param', queryParamStrategy],
  ['jwt-hs256', jwtHs256Strategy],
  ['hmac-sha256-v4', hmacSha256V4Strategy],
]);

export function getAuthStrategy(type: AuthType): AuthStrategy {
  const strategy = strategies.get(type);
  if (!strategy) throw new Error(`Unknown auth type: ${type}`);
  return strategy;
}
