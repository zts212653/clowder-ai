import { z } from 'zod';

const chunkSchema = z.object({
  encoding: z.literal('json-text-chunk'),
  snapshot: z.string(),
  json: z.string(),
  nextCursor: z.number().int().nonnegative().nullable(),
});
/** Assemble every owner page before parsing or displaying a body. A changed snapshot fails closed. */
export class SharedArtifactCatalogueReconciled extends Error {
  constructor() {
    super('作品版本记录已恢复，正在读取最新版。');
  }
}

export async function readArtifactJsonPages(
  read: (page: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  let value = await read({});
  const reconciled = z.object({ catalogueReconciled: z.literal(true) }).safeParse(value).success;
  // Receipt reconciliation can change the latest revision before the next page. Refresh before reading any body.
  if (reconciled) throw new SharedArtifactCatalogueReconciled();
  const first = chunkSchema.safeParse(value);
  if (!first.success) return value;
  let chunk = first.data;
  let json = '';
  let cursor = 0;
  for (let pages = 0; pages < 2048; pages += 1) {
    if (chunk.snapshot !== first.data.snapshot) throw new Error('作品正在更新，请重新打开。');
    json += chunk.json;
    if (chunk.nextCursor === null) return JSON.parse(json);
    if (chunk.nextCursor <= cursor || json.length > 10000000) throw new Error('作品读取未完成，请重试。');
    cursor = chunk.nextCursor;
    value = await read({ cursor, expectedSnapshot: first.data.snapshot });
    chunk = chunkSchema.parse(value);
  }
  throw new Error('作品读取未完成，请重试。');
}
