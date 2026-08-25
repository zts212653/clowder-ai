/** Return a string's Unicode scalar count, or null for malformed UTF-16. */
export function unicodeScalarLength(value: string): number | null {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
    count += 1;
  }
  return count;
}

/** Closed string admission shared by current input and historical hydration. */
export function isBoundedScalarString(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false;
  const length = unicodeScalarLength(value);
  return length !== null && length > 0 && length <= maxLength;
}
