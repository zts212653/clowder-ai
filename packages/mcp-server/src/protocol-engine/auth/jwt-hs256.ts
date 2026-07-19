import { createHmac } from 'node:crypto';
import type { AuthResult, AuthStrategy } from '../types.js';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildJwt(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iss: accessKey,
        iat: now,
        nbf: now - 5,
        exp: now + 1800,
      }),
    ),
  );
  const sig = base64url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export const jwtHs256Strategy: AuthStrategy = {
  type: 'jwt-hs256',
  sign(credentials): AuthResult {
    const ak = credentials['accessKey'] ?? credentials['access_key'] ?? '';
    const sk = credentials['secretKey'] ?? credentials['secret_key'] ?? '';
    const token = buildJwt(ak, sk);
    const bearer = `Bearer ${token}`;
    return { headers: { Authorization: bearer }, sensitiveArtifacts: [bearer, token] };
  },
};
