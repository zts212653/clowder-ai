/**
 * String.slice with UTF-16 budgets, moving cut boundaries inward to keep pairs whole.
 * Preserves well-formed input without scanning/copying it into code-point arrays.
 * This is not a sanitizer for malformed source text or a grapheme-cluster slicer.
 */
export function sliceUnicodeSafe(value: string, start: number, end?: number): string {
  let from = sliceIndex(start, value.length);
  let to = end === undefined ? value.length : sliceIndex(end, value.length);
  if (from >= to) return '';
  if (splitsSurrogatePair(value, from)) from++;
  if (splitsSurrogatePair(value, to)) to--;
  return value.slice(from, to);
}

function sliceIndex(index: number, length: number): number {
  const integer = Number.isNaN(index) ? 0 : Math.trunc(index);
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}

function splitsSurrogatePair(value: string, index: number): boolean {
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
