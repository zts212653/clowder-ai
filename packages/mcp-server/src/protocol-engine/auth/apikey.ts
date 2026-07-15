import type { AuthResult, AuthStrategy } from '../types.js';

export const apikeyStrategy: AuthStrategy = {
  type: 'apikey',
  sign(credentials): AuthResult {
    const key = credentials['apiKey'] ?? credentials['api_key'] ?? '';
    const bearer = `Bearer ${key}`;
    return { headers: { Authorization: bearer }, sensitiveArtifacts: [bearer] };
  },
};

export const queryParamStrategy: AuthStrategy = {
  type: 'query-param',
  sign(credentials): AuthResult {
    const key = credentials['apiKey'] ?? credentials['api_key'] ?? '';
    const paramName = credentials['_authParamName'] ?? 'key';
    const encoded = encodeURIComponent(key);
    const artifacts = encoded !== key ? [encoded] : [];
    return { queryParams: { [paramName]: key }, sensitiveArtifacts: artifacts };
  },
};
