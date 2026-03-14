/**
 * Normalize arbitrary thrown values into a human-readable error string.
 * Covers: Error instances, plain strings, objects with .message, and fallback to String().
 */
export function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  try {
    const s = String(err);
    return s !== '[object Object]' ? s : JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}
