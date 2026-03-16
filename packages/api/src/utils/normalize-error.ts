/**
 * Normalize arbitrary thrown values into a human-readable error string.
 * Covers: Error instances, plain strings, objects with .message, and fallback to String().
 */
export function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    try {
      const message = Reflect.get(err, 'message');
      if (typeof message === 'string') return message;
    } catch {
      // Fall through to the generic fallback path when message access is hostile.
    }
  }
  try {
    const s = String(err);
    return s !== '[object Object]' ? s : JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}
