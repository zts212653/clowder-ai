const REPLACEMENT_CHARACTER = '\uFFFD';

function normalizeStringUnicode(value: string): string {
  const chunks: string[] = [];
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    if (isHighSurrogate) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
        continue;
      }
    }

    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
    if (!isHighSurrogate && !isLowSurrogate) continue;

    chunks.push(value.slice(segmentStart, index), REPLACEMENT_CHARACTER);
    segmentStart = index + 1;
  }

  if (chunks.length === 0) return value;
  chunks.push(value.slice(segmentStart));
  return chunks.join('');
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeArray(value: readonly unknown[]): readonly unknown[] {
  let normalized: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = normalizeValue(current);
    if (next !== current) {
      normalized ??= [...value];
      normalized[index] = next;
    }
  }
  return normalized ?? value;
}

function normalizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  let normalized: Record<string, unknown> | undefined;
  for (const [key, current] of Object.entries(value)) {
    const next = normalizeValue(current);
    if (next !== current) {
      normalized ??= { ...value };
      normalized[key] = next;
    }
  }
  return normalized ?? value;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeStringUnicode(value);
  if (Array.isArray(value)) return normalizeArray(value);
  if (value && typeof value === 'object' && isPlainRecord(value)) return normalizeRecord(value);
  return value;
}

/**
 * Convert every string leaf in a JSON-shaped value to Unicode scalar values.
 * Valid surrogate pairs are preserved; isolated UTF-16 surrogates become U+FFFD.
 * The input is returned unchanged when already well formed and is never mutated.
 */
export function normalizeJsonUnicode<T>(value: T): T {
  return normalizeValue(value) as T;
}
