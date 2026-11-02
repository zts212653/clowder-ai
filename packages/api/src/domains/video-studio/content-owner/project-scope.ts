import {
  type CollectiveContentScopeV1,
  collectiveContentOperationContextSchema,
  collectiveContentScopeRef,
} from './collective-scope.js';
import type { ContentOperationContextV1, ContentPublicationScopeV1, VideoProjectScopeV1 } from './types.js';

export const videoProjectMediaType = 'application/vnd.cat-cafe.video-project+json';

export function validateContentOperationContext(
  context: ContentOperationContextV1 | undefined,
  scope?: VideoProjectScopeV1,
  collectiveScope?: CollectiveContentScopeV1,
) {
  if (collectiveScope) {
    const parsed = collectiveContentOperationContextSchema.safeParse(context);
    if (!parsed.success || parsed.data.scopeRef !== collectiveContentScopeRef(collectiveScope) || scope)
      throw new TypeError('Invalid Collective owner operation context');
    return;
  }
  if (context === undefined) return;
  if (!context || typeof context !== 'object' || Array.isArray(context))
    throw new TypeError('Invalid video project operation context');
  if (
    (context.kind === 'work:create' || context.kind === 'work:submit') &&
    !scope &&
    /^sha256:[a-f0-9]{64}$/.test(context.requestDigest) &&
    Object.keys(context).every((key) => key === 'kind' || key === 'requestDigest')
  )
    return;
  if (
    !scope ||
    ![
      'video-project:create',
      'video-project:save',
      'video-project:archive',
      'video-project:decision',
      'video-project:screening',
      'video-project:self-review',
    ].includes(context.kind) ||
    !/^sha256:[a-f0-9]{64}$/.test(context.requestDigest) ||
    Object.keys(context).some((key) => key !== 'kind' && key !== 'requestDigest')
  )
    throw new TypeError('Invalid video project operation context');
}

/** This authority is established once by Host import, never by JSON project content. */
export function validateVideoProjectScope(
  scope: VideoProjectScopeV1 | undefined,
  contentRef: string,
  mediaType: string,
  publicationScope?: ContentPublicationScopeV1,
): void {
  if (scope === undefined) {
    if (contentRef.startsWith('video-project:') || mediaType === videoProjectMediaType)
      throw new TypeError('Video project scope is required');
    return;
  }
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    scope.kind !== 'video-project' ||
    typeof scope.ownerUserId !== 'string' ||
    !scope.ownerUserId ||
    scope.ownerUserId.length > 256 ||
    scope.ownerUserId.trim() !== scope.ownerUserId ||
    scope.ownerUserId.includes('\0') ||
    typeof scope.projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(scope.projectId) ||
    contentRef !== `video-project:${scope.projectId}` ||
    mediaType !== videoProjectMediaType ||
    publicationScope ||
    Object.keys(scope).some((key) => !['kind', 'ownerUserId', 'projectId'].includes(key))
  )
    throw new TypeError('Invalid video project scope');
}
