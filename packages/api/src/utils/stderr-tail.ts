/**
 * F319: bounded stderr tail with an optional line observer.
 *
 * Child CLIs running trace-level logging can write megabytes per turn. Exit
 * diagnostics (F212) only ever read the last few hundred characters, so the
 * retained text is a tail; the line observer sees every complete line exactly
 * once and must not retain them. A partial line is carried only up to
 * `maxLineChars`; a longer newline-less run is dropped (the observer never
 * sees it) so nothing here grows without bound.
 */

/** Trace lines carry whole Responses API objects; 4 MiB leaves ample headroom. */
export const DEFAULT_STDERR_MAX_LINE_CHARS = 4 * 1024 * 1024;

export interface StderrTail {
  /** Append raw chunk text (may contain partial lines). */
  append(text: string): void;
  /** Deliver a trailing partial line to the observer (call at stream end). */
  flush(): void;
  /** Retained tail, at most `maxChars` long. */
  readonly value: string;
}

export function createStderrTail(options: {
  maxChars: number;
  maxLineChars?: number;
  onLine?: (line: string) => void;
}): StderrTail {
  const { maxChars, onLine } = options;
  const maxLineChars = options.maxLineChars ?? DEFAULT_STDERR_MAX_LINE_CHARS;
  let tail = '';
  let carry = '';
  let discardingOversizedLine = false;
  const deliver = (line: string): void => {
    if (line.length > maxLineChars) return;
    onLine?.(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  return {
    append(text) {
      if (!text) return;
      tail += text;
      if (tail.length > maxChars) tail = tail.slice(-maxChars);
      if (!onLine) return;
      let rest = text;
      while (rest.length > 0) {
        const newline = rest.indexOf('\n');
        if (newline < 0) {
          if (discardingOversizedLine) return;
          carry += rest;
          if (carry.length > maxLineChars) {
            carry = '';
            discardingOversizedLine = true;
          }
          return;
        }
        const segment = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          continue;
        }
        const line = carry + segment;
        carry = '';
        deliver(line);
      }
    },
    flush() {
      if (!onLine) return;
      if (discardingOversizedLine) {
        discardingOversizedLine = false;
        carry = '';
        return;
      }
      if (carry.length === 0) return;
      const line = carry;
      carry = '';
      deliver(line);
    },
    get value() {
      return tail;
    },
  };
}
