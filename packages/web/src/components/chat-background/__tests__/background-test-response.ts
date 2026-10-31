import { type ChatBackgroundMetadata, type ChatBackgroundState, serializeChatBackgroundState } from '@cat-cafe/shared';

/** The API retains v1 choices and binds new metadata beside them, never inside the image. */
export function backgroundResponse(background?: ChatBackgroundState | null, metadata?: ChatBackgroundMetadata) {
  if (!background) return { threads: {} };
  const state = background.kind === 'image' ? { ...background, ...metadata } : background;
  const encoded = serializeChatBackgroundState(state);
  return {
    global: encoded.background,
    threads: {},
    ...(encoded.metadata
      ? { metadata: { global: { background: encoded.background, ...encoded.metadata }, threads: {} } }
      : {}),
  };
}
