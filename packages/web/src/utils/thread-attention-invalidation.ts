export const THREAD_ATTENTION_INVALIDATED = 'cat-cafe:thread-attention-invalidated';

/** A committed or uncertain thread lifecycle change needs canonical Group readback. */
export function invalidateThreadAttentionPreferences(): void {
  window.dispatchEvent(new Event(THREAD_ATTENTION_INVALIDATED));
}
