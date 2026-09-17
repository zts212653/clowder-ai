import type { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import { DOCX_MEDIA_TYPE } from './editor-bridge/service.js';
import {
  EditorSessionError,
  type EditorSessionService,
  type PreparedEditorSessionV1,
} from './editor-session-service.js';
import type { CollaborativeContentOperationV1, CollaborativePatchService, ContentAnchorV1 } from './patch-service.js';
import type { WorkspaceEditorService } from './workspace-editor-service.js';

export interface ContentInspectionPort {
  inspect(input: {
    readonly authority: PreparedEditorSessionV1;
    readonly bytes: Buffer;
    readonly mediaType: string;
    readonly cursor: number;
    readonly limit: number;
  }): Promise<{
    readonly paragraphs: readonly { readonly target: ContentAnchorV1; readonly editable: boolean }[];
    readonly nextCursor: number | null;
  }>;
}

/** Principals originate from callback authentication, never from the request body.
 * Each call owns an independent short-lived editor bearer, which never leaves Host.
 */
export class NamedCatContentService {
  constructor(
    private readonly options: {
      readonly ownerUserId: string;
      readonly sessions: EditorSessionService;
      readonly owner: Pick<ProjectContentOwnerService, 'load'>;
      readonly patches: Pick<CollaborativePatchService, 'submit'>;
      readonly inspector: ContentInspectionPort;
      readonly workspace?: Pick<WorkspaceEditorService, 'resolveExisting'>;
    },
  ) {}

  async inspect(input: {
    readonly principal: { readonly userId: string; readonly catId: string };
    readonly contentRef?: string;
    readonly workspace?: { readonly worktreeId: string; readonly path: string };
    readonly expectedOwnerRevision?: number;
    readonly cursor: number;
    readonly limit: number;
    readonly maxChars: number;
  }) {
    this.assertOwner(input.principal);
    if (Boolean(input.contentRef) === Boolean(input.workspace)) throw new TypeError('One document locator required');
    let contentRef = input.contentRef;
    if (!contentRef) {
      if (!input.workspace || !this.options.workspace)
        throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Workspace document lookup unavailable');
      contentRef = await this.options.workspace.resolveExisting(input.workspace);
    }
    const resolved = { ...input, contentRef };
    return this.withSession(resolved, async (session) => {
      const current = await this.options.owner.load(resolved.contentRef);
      if (input.expectedOwnerRevision !== undefined && input.expectedOwnerRevision !== current.ownerRevision) {
        return { status: 'conflict' as const, actualOwnerRevision: current.ownerRevision };
      }
      if (current.mediaType !== DOCX_MEDIA_TYPE)
        throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Unsupported document type');
      const { sessionToken: _bearer, ...authority } = session;
      const result = await this.options.inspector.inspect({
        authority,
        bytes: current.bytes,
        mediaType: current.mediaType,
        cursor: input.cursor,
        limit: input.limit,
      });
      const paragraphs: (typeof result.paragraphs)[number][] = [];
      let characters = 0;
      for (const row of result.paragraphs) {
        const size = JSON.stringify(row).length;
        if (characters + size > input.maxChars) break;
        paragraphs.push(row);
        characters += size;
      }
      return this.options.sessions.run(session.sessionToken, async () => {
        const latest = await this.options.owner.load(resolved.contentRef);
        if (latest.ownerRevision !== current.ownerRevision)
          return { status: 'conflict' as const, actualOwnerRevision: latest.ownerRevision };
        if (paragraphs.length === 0 && result.paragraphs.length > 0) {
          return { status: 'budget_exceeded' as const, requiredChars: JSON.stringify(result.paragraphs[0]).length };
        }
        return {
          status: 'ready' as const,
          dataKind: 'untrusted_document' as const,
          contentRef: resolved.contentRef,
          ownerRevision: current.ownerRevision,
          paragraphs,
          nextCursor:
            paragraphs.length < result.paragraphs.length ? input.cursor + paragraphs.length : result.nextCursor,
        };
      });
    });
  }

  async edit(input: {
    readonly principal: { readonly userId: string; readonly catId: string };
    readonly contentRef: string;
    readonly expectedOwnerRevision: number;
    readonly operationId: string;
    readonly operation: Exclude<CollaborativeContentOperationV1, { readonly kind: 'direct-settlement' }>;
  }) {
    return this.withSession(input, (session) =>
      this.options.patches.submit({
        sessionToken: session.sessionToken,
        expectedOwnerRevision: input.expectedOwnerRevision,
        operationId: input.operationId,
        operation: input.operation,
      }),
    );
  }

  private async withSession<T>(
    input: { readonly principal: { readonly userId: string; readonly catId: string }; readonly contentRef: string },
    work: (session: Awaited<ReturnType<EditorSessionService['activate']>>) => Promise<T>,
  ): Promise<T> {
    this.assertOwner(input.principal);
    const issued = await this.options.sessions.issue({
      contentRef: input.contentRef,
      principal: { kind: 'cat', subjectId: input.principal.catId },
    });
    try {
      const active = await this.options.sessions.activate({
        sessionToken: issued.sessionToken,
        surfaceIntegrity: issued.surfaceIntegrity,
      });
      return await work(active);
    } finally {
      await this.options.sessions.closeRef({
        sessionRef: issued.sessionRef,
        principal: { kind: 'cat', subjectId: input.principal.catId },
      });
    }
  }

  private assertOwner(principal: { readonly userId: string }): void {
    if (principal.userId !== this.options.ownerUserId)
      throw new EditorSessionError('PRINCIPAL_MISMATCH', 'Document owner access denied');
  }
}
