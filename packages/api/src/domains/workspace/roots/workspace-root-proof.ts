import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  linkedRootConfigPath,
  mutateLinkedRootState,
  rootConnectionSourceSchema,
} from './workspace-linked-root-store.js';

const proofSchema = z
  .object({
    userId: z.string().min(1).max(256),
    root: z.string().min(1).max(4096),
    expectedEpoch: z.number().int().nonnegative(),
    source: rootConnectionSourceSchema,
  })
  .strict();
type RootConnectionProof = z.infer<typeof proofSchema>;
const purpose = 'f063-root-preparation-v1:';
const signature = (secret: string, body: string) =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(purpose).update(body).digest();
const keyPath = () => join(dirname(linkedRootConfigPath()), 'secrets', 'root-preparation.key');

function readSecret(): string | null {
  try {
    const key = readFileSync(keyPath(), 'utf8');
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Workspace preparation signing key is invalid');
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function signingSecret(): string {
  return (
    readSecret() ??
    mutateLinkedRootState(() => {
      const existing = readSecret();
      if (existing) return { value: existing, changed: false };
      const key = randomBytes(32).toString('hex');
      const path = keyPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(file, key);
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        renameSync(temporary, path);
        const directory = openSync(dirname(path), 'r');
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return { value: key, changed: false };
    })
  );
}

/** Minted only after source resolution. Initial key creation grants no directory access. */
export function issueRootConnectionProof(input: RootConnectionProof): string {
  const claims = proofSchema.parse(input);
  const secret = signingSecret();
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signature(secret, body).toString('base64url')}`;
}

/** The durable deployment key survives restart; epochs and the source policy are checked at commit. */
export function verifyRootConnectionProof(token: string): RootConnectionProof | null {
  const secret = readSecret();
  if (!secret || token.length > 20_000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const body = parts[0]!;
    const received = Buffer.from(parts[1]!, 'base64url');
    const expected = signature(secret, body);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    return proofSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}
