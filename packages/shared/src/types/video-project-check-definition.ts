import { type VideoProjectCheckPage, videoProjectCheckPageSchema } from './video-project-settings.js';

/**
 * Check-definition digest input v1: UTF-8 compact JSON, recursively sorted object
 * keys, unchanged array order and Unicode spelling, absent optional fields omitted.
 * This page schema contains no numbers. It matches Python json.dumps(...,
 * ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8').
 * Unpaired surrogates cannot be UTF-8 encoded by that contract and are rejected.
 * Other project/operation fingerprints keep their own existing encoding.
 */
export function encodeVideoProjectCheckPageDefinition(page: VideoProjectCheckPage): string {
  return encodeDefinitionValue(videoProjectCheckPageSchema.parse(page));
}

function encodeDefinitionValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw new TypeError('Check page definition requires valid Unicode scalar values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeDefinitionValue).join(',')}]`;
  if (typeof value === 'object') {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${encodeDefinitionValue(field)}`).join(',')}}`;
  }
  throw new TypeError('Unsupported check page definition value');
}
