import { createHash } from 'node:crypto';
import {
  messageMediaItemSelectorSchema,
  projectThreadWorks,
  reviewedMediaAssetSchema,
  workspaceContentReviewSchema,
} from '@cat-cafe/shared';
import { fixtureForApi, IMAGE_FIXTURE } from './f309-ordinary-workspace-journey-fixture.mjs';
import { createF322BControlledFixture } from './f322-b-controlled-fixture.mjs';
import { createWorkspaceFileFixture, WORKSPACE_BINARY_FILES } from './f322-b-workspace-v3-file-fixture.mjs';

export const WORKSPACE_SAMPLE_THREAD = 'thread-f322-workspace-v3-controlled';
export const WORKSPACE_SAMPLE_MARKDOWN = {
  type: 'file',
  name: 'f322-controlled.md',
  ref: 'docs/f322-controlled.md',
  fileLedgerRef: 'docs/f322-controlled.md',
  catId: 'codex61-sol',
  createdAt: 1791711000000,
  sourceMessageId: 'controlled-workspace-acceptance-receipt',
};
export const WORKSPACE_SAMPLE_PUBLISHED_TEXT = {
  type: 'file',
  name: 'f322-controlled-published.md',
  url: '/uploads/f322-controlled-published.md',
  catId: 'codex61-sol',
  createdAt: WORKSPACE_SAMPLE_MARKDOWN.createdAt,
  sourceMessageId: 'sample-published-text-message',
  publicationItem: { kind: 'rich-file', blockId: 'sample-published-text-block' },
};
export const WORKSPACE_PUBLISHED_TEXT_BODY = '# F322 published Markdown\n\nOriginal published words.\n';
const publicationAssets = new Map([
  [WORKSPACE_SAMPLE_PUBLISHED_TEXT.url, { contentType: 'text/markdown', body: WORKSPACE_PUBLISHED_TEXT_BODY }],
  ...WORKSPACE_BINARY_FILES.map((sample) => [sample.url, { contentType: sample.contentType, body: sample.bytes }]),
]);

/** Explicit samples only: no cats, commands, Redis, files, or real review mutations are run. */
export function createWorkspaceV3Fixture() {
  const base = createF322BControlledFixture(WORKSPACE_SAMPLE_THREAD);
  const file = createWorkspaceFileFixture(WORKSPACE_SAMPLE_MARKDOWN, 'f322-sample-user');
  const calls = [];
  const contentRef = `prepared-media:${'c'.repeat(64)}`;
  const image = {
    type: 'image',
    name: 'F322 controlled image A.png',
    catId: 'codex61-sol',
    createdAt: 1791711200000,
    sourceMessageId: 'sample-artwork-message',
    url: '/uploads/f322-controlled-a.png',
    publicationItem: { kind: 'media-gallery', blockId: 'sample-artwork-block', itemIndex: 0 },
    work: { contentRef, ownerRevision: 4, currentOwnerRevision: 9 },
  };
  const artifacts = [
    image,
    {
      ...image,
      name: 'F322 controlled image B.png',
      createdAt: image.createdAt - 1000,
      url: '/uploads/f322-controlled-b.png',
      sourceMessageId: 'sample-artwork-message-b',
      publicationItem: { ...image.publicationItem, blockId: 'sample-artwork-block-b' },
      work: undefined,
    },
    WORKSPACE_SAMPLE_MARKDOWN,
    {
      type: 'pr',
      name: 'Controlled PR coordinates — no live PR action',
      catId: 'codex61-sol',
      createdAt: 1791710900000,
      sourceMessageId: null,
      ref: 'zts212653/clowder-ai#5385',
    },
    {
      type: 'file',
      name: 'Controlled slides.pptx',
      catId: null,
      createdAt: 1791710800000,
      sourceMessageId: null,
      url: '/uploads/f322-controlled-slides.pptx',
    },
    {
      type: 'file',
      name: 'Controlled document.pdf',
      catId: null,
      createdAt: 1791710700000,
      sourceMessageId: null,
      url: '/uploads/f322-controlled-document.pdf',
    },
  ];
  let executions = Array.from({ length: 20 }, (_, index) => {
    const prototype = index % 2 ? base.managed : base.live;
    const executionId = index < 2 ? prototype.executionId : `controlled-execution-${index}`;
    const threadId = index < 2 ? WORKSPACE_SAMPLE_THREAD : `controlled-thread-${index}`;
    return {
      ...prototype,
      executionId,
      threadId,
      threadTitle: `受控样本 · ${index < 2 ? '当前对话' : `其他对话 ${index}`}`,
      projectPath: '/project/cat-cafe',
      ...(index % 2 ? {} : { turnInvocationId: index === 0 ? base.live.turnInvocationId : `controlled-turn-${index}` }),
      cancelability: {
        state: 'cancelable',
        target:
          index % 2
            ? { kind: 'managed_command', taskId: executionId }
            : { kind: 'live_invocation', threadId, catId: prototype.catId, executionId },
      },
    };
  });
  let catalogue = artifacts;
  base.setExecutions(executions);
  const asset = {
    contentRef,
    ownerRevision: 4,
    blobDigest: `sha256:${createHash('sha256').update(IMAGE_FIXTURE.bytes).digest('hex')}`,
    mediaType: 'image/png',
    media: IMAGE_FIXTURE.media,
    sourcePublication: {
      artifactRef: 'controlled-artifact-a',
      sourceRef: 'sample-artwork-message',
      revision: String(image.createdAt),
      threadId: WORKSPACE_SAMPLE_THREAD,
    },
    ownerReceiptRef: 'controlled-publication-receipt-a',
  };
  const { media: _media, mediaType: _mediaType, ...publication } = asset;
  const source = {
    kind: 'publication',
    revision: `sha256:${createHash('sha256')
      .update(JSON.stringify([contentRef, 4]))
      .digest('hex')}`,
    mime: asset.mediaType,
    media: asset.media,
    publication,
  };
  const reviewId = `workspace-review-${'b'.repeat(64)}`;
  const reviewView = {
    review: {
      version: 1,
      reviewId,
      ownerUserId: 'f322-sample-user',
      contentRef,
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
  for (const artifact of artifacts) {
    if (artifact.publicationItem) messageMediaItemSelectorSchema.parse(artifact.publicationItem);
  }
  reviewedMediaAssetSchema.parse(asset);
  workspaceContentReviewSchema.parse(reviewView.review);
  const thread = {
    id: WORKSPACE_SAMPLE_THREAD,
    title: 'F322 Workspace v3 · 明确受控样本',
    projectPath: '/project/cat-cafe',
    createdAt: image.createdAt,
    lastActiveAt: image.createdAt,
  };
  const state = { fixture: IMAGE_FIXTURE };
  return {
    get artifacts() {
      return catalogue;
    },
    get executions() {
      return executions;
    },
    setExecutions(items) {
      executions = items;
      base.setExecutions(items);
    },
    calls,
    image,
    asset,
    file,
    setArtifacts(items) {
      catalogue = items;
    },
    async answer(route) {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      calls.push({ path: pathname, method: request.method(), body: request.postData() });
      const publicationAsset = publicationAssets.get(pathname);
      if (publicationAsset) return route.fulfill(publicationAsset);
      const fileResponse = file.response(request, url);
      if (fileResponse)
        return route.fulfill({
          status: fileResponse.status ?? 200,
          contentType: 'application/json',
          body: JSON.stringify(fileResponse.body),
        });
      if (pathname.startsWith('/uploads/f322-controlled-') && pathname.endsWith('.png'))
        return route.fulfill({ contentType: 'image/png', body: IMAGE_FIXTURE.bytes });
      let body;
      const executionThread = executions.find((item) => pathname === `/api/threads/${item.threadId}`);
      if (request.method() === 'DELETE' && pathname.startsWith('/api/callbacks/hold-ball/')) {
        const id = decodeURIComponent(pathname.split('/').at(-1));
        executions = executions.filter((item) => item.executionId !== id);
        base.setExecutions(executions);
        body = { cancelled: true };
      } else if (request.method() === 'POST' && pathname.endsWith('/cancel')) {
        const id = decodeURIComponent(pathname.split('/').at(-2));
        executions = executions.filter((item) => item.executionId !== id);
        base.setExecutions(executions);
        body = { cancelled: true };
      } else if (pathname === '/api/threads')
        body = {
          threads: [
            thread,
            ...executions
              .filter((item) => item.threadId !== thread.id)
              .map((item) => ({ ...thread, id: item.threadId, title: item.threadTitle })),
          ],
        };
      else if (pathname === `/api/threads/${WORKSPACE_SAMPLE_THREAD}`) body = thread;
      else if (executionThread) body = { ...thread, id: executionThread.threadId, title: executionThread.threadTitle };
      else if (pathname === '/api/messages' && url.searchParams.get('threadId') !== WORKSPACE_SAMPLE_THREAD) {
        const item = executions.find((item) => item.threadId === url.searchParams.get('threadId'));
        body = {
          messages: item
            ? [
                {
                  ...base.message,
                  threadId: item.threadId,
                  id: `controlled-message-${item.executionId}`,
                  catId: item.catId,
                  extra: { stream: { invocationId: item.executionId, turnInvocationId: item.turnInvocationId } },
                },
              ]
            : [],
          hasMore: false,
        };
      } else if (pathname === '/api/executions/active')
        body =
          url.searchParams.get('scope') === 'all'
            ? { scope: 'all', projectPath: null, executions, unavailableProjectPaths: [] }
            : { projectPath: thread.projectPath, executions };
      else if (pathname.endsWith('/queue'))
        body = {
          queue: [],
          paused: false,
          activeInvocations: executions
            .filter((item) => item.kind === 'live_invocation' && pathname === `/api/threads/${item.threadId}/queue`)
            .map((item) => ({
              catId: item.catId,
              executionId: item.executionId,
              turnInvocationId: item.turnInvocationId,
              startedAt: item.startedAt,
            })),
        };
      else if (pathname.endsWith('/read/latest'))
        body = { advanced: false, caughtUp: true, messageId: base.message.id };
      else if (pathname.endsWith('/sessions'))
        body = {
          sessions: [
            {
              id: 'sample-session',
              catId: base.live.catId,
              seq: 4,
              status: 'active',
              messageCount: 1,
              createdAt: base.live.startedAt,
            },
          ],
        };
      else if (pathname.endsWith('/artifacts'))
        body = {
          threadId: WORKSPACE_SAMPLE_THREAD,
          artifacts:
            pathname === '/api/artifacts'
              ? catalogue.map((item) => ({ ...item, threadId: WORKSPACE_SAMPLE_THREAD, threadTitle: thread.title }))
              : catalogue,
          workLineage: 'resolved',
          ...(url.searchParams.get('view') === 'works'
            ? { view: 'works', complete: true, total: projectThreadWorks(catalogue, true).length }
            : {}),
        };
      else if (pathname === '/api/workspace/worktrees')
        body = {
          worktrees: [
            {
              id: 'worktree-f322-controlled',
              root: thread.projectPath,
              branch: 'controlled-sample',
              head: 'controlled-sample',
            },
          ],
        };
      else if (pathname === '/api/workspace/search')
        body = {
          results: [
            {
              path: WORKSPACE_SAMPLE_MARKDOWN.ref,
              line: 0,
              content: 'Controlled Markdown sample',
              contextBefore: '',
              contextAfter: '',
              matchType: 'filename',
            },
          ],
        };
      else if (pathname === '/api/workspace/diff') body = { files: [], diff: '' };
      else if (pathname === '/api/video-projects') body = { projects: [] };
      else if (pathname === '/api/agent-hooks/status') body = { status: 'ready', targets: [] };
      else if (pathname === '/api/runtime-deployment/waits')
        body =
          url.searchParams.get('scope') === 'all'
            ? { scope: 'all', projectPath: null, items: [], candidate: null }
            : { projectPath: thread.projectPath, items: [], candidate: null };
      else if (pathname === '/api/content-publications/resolve')
        body = { status: 'resolved', ownerUserId: 'f322-sample-user', asset };
      else if (pathname === '/api/content-reviews/resolve') body = { ownerUserId: 'f322-sample-user', contexts: [] };
      else if (pathname === '/api/content-reviews/prepare' || pathname === `/api/content-reviews/${reviewId}`)
        body = reviewView;
      else if (pathname.startsWith('/api/content-publications/') && pathname.includes('/media/'))
        return route.fulfill({ contentType: 'image/png', body: IMAGE_FIXTURE.bytes });
      else if (pathname.startsWith('/api/content-publications/')) body = { asset, currentOwnerRevision: 9 };
      else body = base.response(url, request.method()) ?? fixtureForApi(url, 'filename', state);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    },
  };
}
