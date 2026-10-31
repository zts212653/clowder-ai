import type { WorkspaceContentAnnotation } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';

/** Actual MessageStore reads plus current thread/source authority, provided by the authenticated Host. */
export interface VideoProjectMessageAuthority {
  readonly messages: Pick<IMessageStore, 'getById' | 'getByThreadAfter'>;
  readonly authorizeSource: (input: {
    principal: VideoProjectPrincipal;
    threadId: string;
    messageId?: string;
    permission: 'read' | 'write';
  }) => Promise<void>;
}
export type ProjectAnnotationProjection = (
  annotation: WorkspaceContentAnnotation,
) => Promise<WorkspaceContentAnnotation | undefined>;
