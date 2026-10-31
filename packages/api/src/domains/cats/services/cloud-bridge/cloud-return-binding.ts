import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

const TOKEN_PREFIX = 'cbr1';
const SECRET_BYTES = 32;
const SECRET_KEY = 'cloud-bridge:return-binding-secret';

export interface CloudReturnBindingClaims {
  readonly threadId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly dispatchInvocationId: string;
  readonly targetCatId: string;
}

export type CloudReturnBindingVerification =
  | { readonly ok: true; readonly dispatchInvocationId: string }
  | { readonly ok: false; readonly reason: 'invalid_token' | 'scope_mismatch' };

function requireRef(value: string, field: string, maximum: number): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!value || value.length > maximum || hasControlCharacter) {
    throw new Error(`${field} must be a bounded non-empty ref without control characters`);
  }
  return value;
}

function material(claims: CloudReturnBindingClaims): string {
  return JSON.stringify({
    v: 1,
    threadId: requireRef(claims.threadId, 'threadId', 512),
    userId: requireRef(claims.userId, 'userId', 256),
    sourceMessageId: requireRef(claims.sourceMessageId, 'sourceMessageId', 512),
    dispatchInvocationId: requireRef(claims.dispatchInvocationId, 'dispatchInvocationId', 512),
    targetCatId: requireRef(claims.targetCatId, 'targetCatId', 128),
  });
}

/** Stateless opaque capability: only the dispatch ref is encoded; all routing scope is HMAC-bound. */
export class CloudReturnBindingSigner {
  constructor(private readonly secret: Buffer = randomBytes(SECRET_BYTES)) {
    if (secret.length !== SECRET_BYTES) throw new Error('invalid cloud return binding secret');
  }

  sign(claims: CloudReturnBindingClaims): string {
    const dispatchRef = Buffer.from(
      requireRef(claims.dispatchInvocationId, 'dispatchInvocationId', 512),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(material(claims)).digest('base64url');
    return `${TOKEN_PREFIX}.${dispatchRef}.${signature}`;
  }

  verify(
    token: string,
    expected: Omit<CloudReturnBindingClaims, 'dispatchInvocationId'>,
  ): CloudReturnBindingVerification {
    const [prefix, dispatchRef, suppliedSignature, extra] = token.split('.');
    if (prefix !== TOKEN_PREFIX || !dispatchRef || !suppliedSignature || extra !== undefined) {
      return { ok: false, reason: 'invalid_token' };
    }
    let dispatchInvocationId: string;
    try {
      dispatchInvocationId = Buffer.from(dispatchRef, 'base64url').toString('utf8');
      if (Buffer.from(dispatchInvocationId, 'utf8').toString('base64url') !== dispatchRef) {
        return { ok: false, reason: 'invalid_token' };
      }
      requireRef(dispatchInvocationId, 'dispatchInvocationId', 512);
    } catch {
      return { ok: false, reason: 'invalid_token' };
    }
    let expectedSignature: Buffer;
    let actualSignature: Buffer;
    try {
      expectedSignature = createHmac('sha256', this.secret)
        .update(material({ ...expected, dispatchInvocationId }))
        .digest();
      actualSignature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      return { ok: false, reason: 'invalid_token' };
    }
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      return { ok: false, reason: 'scope_mismatch' };
    }
    return { ok: true, dispatchInvocationId };
  }
}

function decodeSecret(encoded: string): Buffer {
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== SECRET_BYTES || secret.toString('base64url') !== encoded) {
    throw new Error('invalid persisted cloud return binding secret');
  }
  return secret;
}

export async function loadOrCreateCloudReturnBindingSigner(redis: RedisClient): Promise<CloudReturnBindingSigner> {
  const candidate = randomBytes(SECRET_BYTES).toString('base64url');
  await redis.set(SECRET_KEY, candidate, 'NX');
  const persisted = await redis.get(SECRET_KEY);
  if (!persisted) throw new Error('cloud return binding secret was not persisted');
  return new CloudReturnBindingSigner(decodeSecret(persisted));
}

export const CloudReturnBindingSecretKey = SECRET_KEY;
