import { ArtifactReviewError } from './artifact-review/errors.js';

export function pageRecords<T extends { records: LeafRecord[]; nextCursor: number | null }>(
  base: T,
  records: LeafRecord[],
  cursor: number,
  maxChars: number,
): T {
  for (let index = cursor; index < records.length; index += 1) {
    const record = records[index];
    if (!record) break;
    const candidate = {
      ...base,
      records: [...base.records, record],
      nextCursor: index + 1 < records.length ? index + 1 : null,
    };
    if (JSON.stringify(candidate).length > maxChars) {
      if (!base.records.length) throw new ArtifactReviewError('limit_reached');
      base.nextCursor = index;
      break;
    }
    base.records.push(record);
    base.nextCursor = candidate.nextCursor;
  }
  return base;
}

export interface LeafRecord {
  path: string;
  value: string | number | boolean | null;
  /** UTF-16 offsets in the original string; concatenate fragments for the same path. */
  offset?: number;
  totalLength?: number;
}
export function leafRecords(value: unknown, path = ''): LeafRecord[] {
  if (value === undefined) return [];
  if (typeof value === 'string' && JSON.stringify({ path, value }).length > 4000) {
    const fragments: LeafRecord[] = [];
    for (let offset = 0; offset < value.length; ) {
      let end = Math.min(offset + 512, value.length);
      // Retain a surrogate pair within one fragment as well as losslessly in the assembled text.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!))
        end -= 1;
      fragments.push({ path, value: value.slice(offset, end), offset, totalLength: value.length });
      offset = end;
    }
    return fragments;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leafRecords(item, `${path}/${index}`));
  if (typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      leafRecords(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
    );
  throw new ArtifactReviewError('invalid_action');
}
