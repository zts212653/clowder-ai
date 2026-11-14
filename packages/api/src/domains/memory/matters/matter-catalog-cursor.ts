import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type MatterActor, MatterMemoryError, matterDigest } from './matter-source.js';

export interface MatterCatalogContext {
  query?: string;
  threadId?: string;
  management?: boolean;
}
const keySchema = z
  .object({ related: z.boolean(), updatedAt: z.number().int(), matterId: z.string().min(1).max(200) })
  .strict();
export type MatterCatalogKey = z.infer<typeof keySchema>;
const progressSchema = z.object({ related: z.boolean(), offset: z.number().int().min(0) }).strict();
export type MatterCatalogProgress = z.infer<typeof progressSchema>;
const cursorSchema = z
  .object({ scope: z.string(), after: keySchema.nullable(), progress: z.string().max(1000).optional() })
  .strict();
// Only budget-limited scans need private progress. Normal visible-item cursors remain restart-stable.
const progressKey = randomBytes(32);

function sealProgress(progress: MatterCatalogProgress, binding: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', progressKey, iv);
  cipher.setAAD(Buffer.from(binding));
  const data = Buffer.concat([cipher.update(JSON.stringify(progress), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function openProgress(token: string, binding: string): MatterCatalogProgress {
  const bytes = Buffer.from(token, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', progressKey, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(binding));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const data = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  return progressSchema.parse(JSON.parse(data.toString('utf8')));
}

function scope(actor: MatterActor, options: MatterCatalogContext): string {
  return matterDigest([
    actor.userId,
    actor.viewer.type === 'user' ? 'owner' : `cat:${actor.viewer.catId}`,
    actor.publicReply === true,
    options.query ?? '',
    options.threadId ?? '',
    options.management === true && actor.viewer.type === 'user',
    'catalog:thread-source-v2',
  ]);
}

/** The same key is used after permission projection, for paging and for a budget-shortened opening. */
export function compareMatterCatalogKeys(a: MatterCatalogKey, b: MatterCatalogKey): number {
  return (
    Number(b.related) - Number(a.related) ||
    b.updatedAt - a.updatedAt ||
    (a.matterId < b.matterId ? -1 : a.matterId > b.matterId ? 1 : 0)
  );
}

export function matterCatalogCursor(
  actor: MatterActor,
  options: MatterCatalogContext,
  after: MatterCatalogKey | null,
  progress?: MatterCatalogProgress,
): string {
  const binding = scope(actor, options);
  return Buffer.from(
    JSON.stringify({
      scope: binding,
      after,
      ...(progress ? { progress: sealProgress(progress, `${binding}:${JSON.stringify(after)}`) } : {}),
    }),
  ).toString('base64url');
}

export function readMatterCatalogCursor(
  actor: MatterActor,
  options: MatterCatalogContext,
  cursor?: string,
): MatterCatalogKey | null {
  return readMatterDiscoveryCursor(actor, options, cursor).after;
}

export function readMatterDiscoveryCursor(
  actor: MatterActor,
  options: MatterCatalogContext,
  cursor?: string,
): {
  after: MatterCatalogKey | null;
  progress?: MatterCatalogProgress;
} {
  if (!cursor) return { after: null };
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.scope !== scope(actor, options)) throw new Error('scope');
    return {
      after: parsed.after,
      ...(parsed.progress
        ? { progress: openProgress(parsed.progress, `${parsed.scope}:${JSON.stringify(parsed.after)}`) }
        : {}),
    };
  } catch {
    throw new MatterMemoryError('invalid_cursor');
  }
}
