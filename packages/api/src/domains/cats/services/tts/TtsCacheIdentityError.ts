export class TtsCacheIdentityError extends Error {
  constructor(
    readonly code: 'TTS_CACHE_IDENTITY_AMBIGUOUS' | 'TTS_CACHE_IDENTITY_UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'TtsCacheIdentityError';
  }
}

/** Expose only the actionable cache condition, not arbitrary transport errors. */
export function ttsUnavailableResponse(error: unknown): { error: string; code?: string } {
  return error instanceof TtsCacheIdentityError
    ? { error: error.message, code: error.code }
    : { error: 'No TTS provider available' };
}
