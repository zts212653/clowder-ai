export interface MediaByteRange {
  readonly start: number;
  readonly end: number;
}

/** One satisfiable HTTP byte range. Multi-range requests are deliberately unsupported. */
export function parseMediaByteRange(value: string, length: number): MediaByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const first = Number(match[1] || match[2]);
  const end = suffix || !match[2] ? length - 1 : Math.min(Number(match[2]), length - 1);
  const start = suffix ? Math.max(0, length - first) : first;
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(end) &&
    (!suffix || first > 0) &&
    start <= end &&
    start < length
    ? { start, end }
    : null;
}
