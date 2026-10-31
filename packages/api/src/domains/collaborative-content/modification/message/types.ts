import type { ContentModificationRequest } from '@cat-cafe/shared';

/** Resolved original-message facts shared by takeover implementations; no runtime dispatcher dependency. */
export interface ResolvedMessageTakeover {
  readonly payload: ContentModificationRequest;
  readonly sourceMessageRevision: `sha256:${string}`;
  readonly sourceVisibility:
    | { readonly visibility: 'public' }
    | { readonly visibility: 'whisper'; readonly whisperTo: readonly string[] };
}
