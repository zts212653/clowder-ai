import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

const BUNDLE_SNAPSHOT_SECRET_KEY = 'paw-feel:disposition:bundle-snapshot-secret';
const BUNDLE_SNAPSHOT_SECRET_BYTES = 32;

export interface PawFeelBundleSnapshotMember {
  signalId: string;
  expectedSequence: number;
}

function material(bundleKey: string, members: readonly PawFeelBundleSnapshotMember[]) {
  return {
    v: 1,
    bundleKey,
    members: [...members]
      .map((member) => [member.signalId, member.expectedSequence] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

export class PawFeelBundleSnapshotSigner {
  constructor(private readonly secret: Buffer = randomBytes(BUNDLE_SNAPSHOT_SECRET_BYTES)) {
    if (secret.length !== BUNDLE_SNAPSHOT_SECRET_BYTES) {
      throw new Error('invalid paw-feel bundle snapshot secret');
    }
  }

  sign(bundleKey: string, members: readonly PawFeelBundleSnapshotMember[]): string {
    const payload = Buffer.from(JSON.stringify(material(bundleKey, members))).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  assert(bundleKey: string, members: readonly PawFeelBundleSnapshotMember[], token: string): void {
    const [encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedPayload || !encodedSignature || extra !== undefined) {
      throw new Error('invalid bundle snapshot token');
    }
    const expectedSignature = createHmac('sha256', this.secret).update(encodedPayload).digest();
    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw new Error('invalid bundle snapshot signature');
    }
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error('bundle snapshot signature mismatch');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw new Error('invalid bundle snapshot payload');
    }
    if (JSON.stringify(payload) !== JSON.stringify(material(bundleKey, members))) {
      throw new Error('bundle snapshot membership mismatch');
    }
  }
}

function decodePersistedSecret(encoded: string): Buffer {
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== BUNDLE_SNAPSHOT_SECRET_BYTES || secret.toString('base64url') !== encoded) {
    throw new Error('invalid persisted paw-feel bundle snapshot secret');
  }
  return secret;
}

export async function loadOrCreatePawFeelBundleSnapshotSigner(
  redis: RedisClient,
): Promise<PawFeelBundleSnapshotSigner> {
  const candidate = randomBytes(BUNDLE_SNAPSHOT_SECRET_BYTES).toString('base64url');
  await redis.set(BUNDLE_SNAPSHOT_SECRET_KEY, candidate, 'NX');
  const persisted = await redis.get(BUNDLE_SNAPSHOT_SECRET_KEY);
  if (!persisted) throw new Error('paw-feel bundle snapshot secret was not persisted');
  return new PawFeelBundleSnapshotSigner(decodePersistedSecret(persisted));
}

export const PawFeelBundleSnapshotSecretKey = BUNDLE_SNAPSHOT_SECRET_KEY;
