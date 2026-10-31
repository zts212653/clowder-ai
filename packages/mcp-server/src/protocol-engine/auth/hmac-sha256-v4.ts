import { createHash, createHmac } from 'node:crypto';
import type { AuthResult, AuthStrategy } from '../types.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function deriveSigningKey(sk: string, dateStamp: string, region: string, service: string): Buffer {
  let key: Buffer = hmacSha256(sk, dateStamp);
  key = hmacSha256(key, region);
  key = hmacSha256(key, service);
  key = hmacSha256(key, 'request');
  return key;
}

interface SigningInput {
  method: string;
  url: string;
  body?: string;
}

function signRequest(
  ak: string,
  sk: string,
  region: string,
  service: string,
  input: SigningInput,
): Record<string, string> {
  const now = new Date();
  const xDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const dateStamp = xDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/request`;

  const parsedUrl = new URL(input.url);
  const queryString = parsedUrl.search ? parsedUrl.search.slice(1) : '';
  const payloadHash = sha256(input.body ?? '');

  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalHeaders = [
    `content-type:application/json`,
    `host:${parsedUrl.host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`,
  ].join('\n');

  const canonicalRequest = [
    input.method,
    parsedUrl.pathname,
    queryString,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(sk, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  return {
    'Content-Type': 'application/json',
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export const hmacSha256V4Strategy: AuthStrategy = {
  type: 'hmac-sha256-v4',
  sign(credentials, request): AuthResult {
    const ak = credentials['accessKey'] ?? credentials['access_key'] ?? '';
    const sk = credentials['secretKey'] ?? credentials['secret_key'] ?? '';
    const region = credentials['region'] ?? 'cn-north-1';
    const service = credentials['service'] ?? 'cv';
    const headers = signRequest(ak, sk, region, service, request);
    // Authorization header contains ak and HMAC signature — both sensitive.
    const authHeader = headers['Authorization'] ?? '';
    return { headers, sensitiveArtifacts: [authHeader] };
  },
};
