import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workspaceContentReviewSchema } from '@cat-cafe/shared';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';

export const WORKSPACE_MARKDOWN_BODY = '# F322 controlled Markdown\n\n原 file owner 读取的同一段 Markdown。\n';
export const WORKSPACE_BINARY_FILES = [
  { name: 'Controlled document.pdf', file: 'controlled.pdf', contentType: 'application/pdf' },
  {
    name: 'Controlled slides.pptx',
    file: 'controlled.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
].map((sample) => ({
  ...sample,
  url: `/uploads/f322-controlled-${sample.file === 'controlled.pdf' ? 'document.pdf' : 'slides.pptx'}`,
  bytes: readFileSync(
    new URL(`../../../../docs/evidence/2026-10-10-f322-b-sol61/controlled-documents/${sample.file}`, import.meta.url),
  ),
}));

/** Original F063/reader contracts over an explicitly controlled in-memory file, never a guessed real path. */
export function createWorkspaceFileFixture(artifact, ownerUserId) {
  const root = '/project/cat-cafe';
  const alias = 'worktree-f322-controlled';
  const worktreeId = canonicalWorktreeId(alias);
  const path = artifact.ref;
  const sha256 = createHash('sha256').update(WORKSPACE_MARKDOWN_BODY).digest('hex');
  const source = {
    kind: 'text',
    locator: { worktreeId, path },
    revision: `sha256:${sha256}`,
    mime: 'text/markdown',
    byteLength: Buffer.byteLength(WORKSPACE_MARKDOWN_BODY),
  };
  const reviewId = `workspace-review-${'d'.repeat(64)}`;
  const view = {
    review: {
      version: 1,
      reviewId,
      ownerUserId,
      contentRef: `workspace-content:${createHash('sha256').update(JSON.stringify(source.locator)).digest('hex')}`,
      source,
      revision: 1,
      annotations: [],
      visualMarks: [],
      createdAt: '2026-10-11T09:00:00.000Z',
      updatedAt: '2026-10-11T09:00:00.000Z',
    },
    sourceState: 'current',
    currentSource: source,
    annotationResolutions: [],
    visualMarkResolutions: [],
    canWrite: true,
  };
  workspaceContentReviewSchema.parse(view.review);
  return {
    worktreeId,
    source,
    response(request, url) {
      if (url.pathname === '/api/workspace/file-locations')
        return {
          body: {
            ownerUserId,
            inventory: 'available',
            locations: [
              {
                root,
                label: 'F322 controlled workspace',
                branch: 'controlled-sample',
                status: 'available',
                connection: 'connected',
                expectedEpoch: 1,
              },
            ],
          },
        };
      if (url.pathname === '/api/workspace/resolve-file-source') {
        const input = JSON.parse(request.postData() ?? '{}');
        if (input.selectedRoot !== root || input.path !== path || input.expectedUserId !== ownerUserId)
          return { status: 404, body: { error: 'controlled_file_location_unavailable' } };
        return { body: { worktreeId, path, kind: 'file', absolutePath: `${root}/${path}` } };
      }
      if (url.pathname === '/api/workspace/file' && url.searchParams.get('path') === path)
        return {
          body: {
            path,
            content: WORKSPACE_MARKDOWN_BODY,
            sha256,
            size: source.byteLength,
            mime: source.mime,
            truncated: false,
            binary: false,
          },
        };
      if (url.pathname === '/api/workspace/content-reviews/prepare') {
        const input = JSON.parse(request.postData() ?? '{}');
        if (input.locator?.worktreeId !== worktreeId || input.locator?.path !== path)
          return { status: 404, body: { error: 'controlled_content_source_unavailable' } };
        return { body: view };
      }
      if (url.pathname === `/api/workspace/content-reviews/${reviewId}`) return { body: view };
      return null;
    },
  };
}
