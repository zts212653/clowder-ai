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
const cursorSchema = z.object({ scope: z.string(), after: keySchema }).strict();

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
  after: MatterCatalogKey,
): string {
  return Buffer.from(JSON.stringify({ scope: scope(actor, options), after })).toString('base64url');
}

export function readMatterCatalogCursor(
  actor: MatterActor,
  options: MatterCatalogContext,
  cursor?: string,
): MatterCatalogKey | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.scope !== scope(actor, options)) throw new Error('scope');
    return parsed.after;
  } catch {
    throw new MatterMemoryError('invalid_cursor');
  }
}
