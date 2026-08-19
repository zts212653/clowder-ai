import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  RECALL_RESOLVER_FAMILIES,
  type RecallScopeV1,
  recallScopeV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const HANDLE_PREFIX = 'mch1';
const HANDLE_KEY_BYTES = 32;
const HANDLE_IV_BYTES = 12;
const MAX_HANDLE_LENGTH = 2_000;
const identifierSchema = z.string().trim().min(1).max(500);
const handleScopeDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

function decodeCanonicalBase64url(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

const encodedHandlePartsSchema = z
  .tuple([
    z.literal(HANDLE_PREFIX),
    z.string().regex(/^[A-Za-z0-9_-]+$/),
    z.string().regex(/^[A-Za-z0-9_-]+$/),
    z.string().regex(/^[A-Za-z0-9_-]+$/),
  ])
  .refine(([, iv, ciphertext, tag]) => {
    const decodedIv = decodeCanonicalBase64url(iv);
    const decodedCiphertext = decodeCanonicalBase64url(ciphertext);
    const decodedTag = decodeCanonicalBase64url(tag);
    return decodedIv?.length === HANDLE_IV_BYTES && (decodedCiphertext?.length ?? 0) > 0 && decodedTag?.length === 16;
  }, 'Invalid authenticated-encryption envelope');

export const memoryCueDrillCoordinateSchema = z
  .object({
    cueId: identifierSchema,
    opportunityId: identifierSchema,
    catalogVersion: z.literal(RECALL_OPPORTUNITY_CATALOG_VERSION),
    resolverFamily: z.enum(RECALL_RESOLVER_FAMILIES),
    resolverVersion: z.number().int().positive(),
    family: z.enum(['person_memory', 'evidence', 'taste']),
    anchor: identifierSchema,
    revision: identifierSchema,
    scope: recallScopeV1Schema,
    expiresAt: z.number().int().nonnegative().finite(),
  })
  .strict();

export type MemoryCueDrillCoordinate = z.infer<typeof memoryCueDrillCoordinateSchema>;

const memoryCueDrillReferenceSchema = z.tuple([
  identifierSchema,
  z.number().int().nonnegative().finite(),
  handleScopeDigestSchema,
]);

type MemoryCueDrillReference = z.infer<typeof memoryCueDrillReferenceSchema>;

export interface MemoryCuePresentedCoordinateReader {
  findPresentedCoordinate(scope: RecallScopeV1, cueId: string, expiresAt: number): MemoryCueDrillCoordinate | null;
}

export type MemoryCueDrillHandleVerification =
  | { ok: true; coordinate: MemoryCueDrillCoordinate }
  | {
      ok: false;
      reason: 'invalid_handle' | 'scope_mismatch' | 'presentation_required';
    }
  | {
      ok: false;
      reason: 'expired';
      coordinate: MemoryCueDrillCoordinate;
    };

function sameScope(left: RecallScopeV1, right: RecallScopeV1): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.threadId === right.threadId &&
    left.invocationId === right.invocationId
  );
}

function scopeDigest(scope: RecallScopeV1): string {
  return createHash('sha256')
    .update([scope.ownerUserId, scope.threadId, scope.invocationId].join('\0'))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/**
 * Creates one process-lifecycle key. Cue envelopes are deliberately ephemeral:
 * restarting the API invalidates old handles instead of restoring derived cue bodies.
 */
export function createProcessMemoryCueDrillSecret(): Buffer {
  return randomBytes(HANDLE_KEY_BYTES);
}

/**
 * Stateless authenticated encryption keeps source coordinates opaque to callers
 * without adding a second cue store. The key is injected explicitly so bootstrap,
 * tests and future rotation policy own its lifecycle rather than this service.
 */
export class MemoryCueDrillHandleService {
  private readonly key: Buffer;

  constructor(
    key: Buffer,
    private readonly presentedCoordinates: MemoryCuePresentedCoordinateReader,
  ) {
    if (key.length !== HANDLE_KEY_BYTES) {
      throw new Error(`Memory cue drill key must be ${HANDLE_KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(key);
  }

  issue(candidate: unknown): string {
    const coordinate = memoryCueDrillCoordinateSchema.parse(candidate);
    const reference: MemoryCueDrillReference = [coordinate.cueId, coordinate.expiresAt, scopeDigest(coordinate.scope)];
    const iv = randomBytes(HANDLE_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(reference), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const handle = [
      HANDLE_PREFIX,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
    if (handle.length > MAX_HANDLE_LENGTH) {
      throw new Error('Memory cue drill coordinate exceeds the opaque handle budget');
    }
    return handle;
  }

  verify(handle: string, serverScope: RecallScopeV1, now: number): MemoryCueDrillHandleVerification {
    const reference = this.decrypt(handle);
    if (!reference) return { ok: false, reason: 'invalid_handle' };
    const [cueId, expiresAt, expectedScopeDigest] = reference;
    if (scopeDigest(serverScope) !== expectedScopeDigest) return { ok: false, reason: 'scope_mismatch' };
    const coordinate = this.presentedCoordinates.findPresentedCoordinate(serverScope, cueId, expiresAt);
    if (!coordinate) return { ok: false, reason: 'presentation_required' };
    if (!sameScope(coordinate.scope, serverScope)) return { ok: false, reason: 'scope_mismatch' };
    if (now >= coordinate.expiresAt) return { ok: false, reason: 'expired', coordinate };
    return { ok: true, coordinate };
  }

  private decrypt(handle: string): MemoryCueDrillReference | null {
    if (handle.length > MAX_HANDLE_LENGTH) return null;
    const parts = encodedHandlePartsSchema.safeParse(handle.split('.'));
    if (!parts.success) return null;
    const [, ivPart, ciphertextPart, tagPart] = parts.data;
    try {
      const iv = Buffer.from(ivPart, 'base64url');
      const ciphertext = Buffer.from(ciphertextPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = memoryCueDrillReferenceSchema.safeParse(JSON.parse(plaintext));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
