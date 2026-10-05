import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const PRODUCTION_BUILD_ID_PATH = path.join(WEB_ROOT, '.next', 'BUILD_ID');
const THREAD_ID = 'thread-f309-ordinary-workspace';
const WORKTREE_ID = 'worktree-f309-ordinary';
const FILE_PATH = 'art/cover.png';
const REVIEW_ID = `workspace-review-${'b'.repeat(64)}`;
const SOURCE_REVISION = `sha256:${'a'.repeat(64)}`;
// The reported ordinary PNG, with honest intrinsic geometry rather than a 1px stand-in.
const IMAGE_BYTES = readFileSync(path.resolve(WEB_ROOT, '../../assets/avatars/antig-opus.png'));
const IMAGE_FIXTURE = {
  filePath: FILE_PATH,
  fileName: 'cover.png',
  revision: SOURCE_REVISION,
  mime: 'image/png',
  bytes: IMAGE_BYTES,
  media: { kind: 'image', width: IMAGE_BYTES.readUInt32BE(16), height: IMAGE_BYTES.readUInt32BE(20) },
};

async function findFreePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert(address && typeof address !== 'string');
  socket.close();
  await once(socket, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The real thread route may still be compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function readProductionBuildId() {
  if (!existsSync(PRODUCTION_BUILD_ID_PATH)) return null;
  return readFile(PRODUCTION_BUILD_ID_PATH, 'utf8');
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const FIXED_API_FIXTURES = new Map([
  ['/api/content-modifications/context', { requests: [], contexts: [] }],
  [
    '/api/content-modifications/choices',
    {
      cats: [{ catId: 'codex-terra', name: '小团团', mcpSupport: true, restrictions: [] }],
      threads: [{ threadId: THREAD_ID, title: 'F309 ordinary Workspace' }],
    },
  ],
  ['/api/session', { userId: 'operator' }],
  ['/api/health', { status: 'ok' }],
  ['/api/ready', { status: 'ok' }],
  [
    '/api/cats',
    {
      cats: [
        {
          id: 'codex-terra',
          displayName: '小团团·砚砚',
          color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
          mentionPatterns: ['@codex-terra'],
          clientId: 'openai',
          defaultModel: 'gpt-5.6-terra',
          avatar: '',
          roleDescription: '',
          personality: '',
          roster: { available: true },
        },
      ],
    },
  ],
  ['/api/config/cat-order', { catOrder: ['codex-terra'] }],
  [
    '/api/concierge/config',
    {
      config: {
        enabled: true,
        muted: true,
        displayName: '猫猫球',
        personaTone: '测试隔离',
        dutyCatProfileId: 'codex-terra',
        proactivePolicy: 'quiet-badge',
        skin: 'xianxian-codex',
        ballPosition: null,
        ballSize: 72,
        behaviorEnabled: false,
      },
    },
  ],
  ['/api/messages', { messages: [], hasMore: false }],
  ['/api/tasks', { tasks: [] }],
  ['/api/bootcamp/threads', { threads: [] }],
  [
    '/api/threads',
    { threads: [{ id: THREAD_ID, title: 'F309 ordinary Workspace', projectPath: '/project/cat-cafe' }] },
  ],
  [`/api/threads/${THREAD_ID}`, { id: THREAD_ID, title: 'F309 ordinary Workspace', projectPath: '/project/cat-cafe' }],
]);

function ordinarySource(fixture = IMAGE_FIXTURE) {
  return {
    kind: 'media',
    // The owner names its source by the durable F063 root the file surface resolved to.
    locator: { worktreeId: canonicalWorktreeId(WORKTREE_ID), path: fixture.filePath },
    revision: fixture.revision,
    mime: fixture.mime,
    byteLength: fixture.bytes.length,
    media: fixture.media,
  };
}

function createReviewState(fixture = IMAGE_FIXTURE) {
  return { annotations: [], revision: 1, visualMarks: [], fixture };
}

function reviewView(state) {
  const source = ordinarySource(state.fixture);
  return {
    review: {
      version: 1,
      reviewId: REVIEW_ID,
      ownerUserId: 'operator',
      contentRef: `workspace-content:${'c'.repeat(64)}`,
      source,
      revision: state.revision,
      annotations: state.annotations,
      visualMarks: state.visualMarks,
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    },
    sourceState: 'current',
    currentSource: source,
    annotationResolutions: state.annotations.map((annotation) => ({ annotationId: annotation.id, status: 'attached' })),
    visualMarkResolutions: state.visualMarks.map((mark) => ({ markId: mark.drawing.id, status: 'attached' })),
    canWrite: true,
  };
}

function fixtureForApi(url, searchType, state) {
  const fixture = state.fixture;
  const fixed = FIXED_API_FIXTURES.get(url.pathname);
  if (fixed) return fixed;
  if (url.pathname.endsWith('/task-progress')) return { taskProgress: {} };
  if (url.pathname.endsWith('/queue')) return { queue: [], paused: false, activeInvocations: [] };
  if (url.pathname.endsWith('/freshness-closures')) return { closures: [], supplements: [] };
  if (url.pathname.endsWith('/executions/active')) return { projectPath: 'default', executions: [] };
  if (url.pathname.endsWith('/invocations')) return { total: 0, invocations: [] };
  if (url.pathname === '/api/workspace/worktrees')
    return { worktrees: [{ id: WORKTREE_ID, root: '/project/cat-cafe', branch: 'feat/f309', head: 'f309' }] };
  if (url.pathname === '/api/workspace/tree')
    return { tree: [{ name: fixture.fileName, path: fixture.filePath, type: 'file' }] };
  if (url.pathname === '/api/workspace/search')
    return {
      results:
        searchType === 'filename'
          ? [{ path: fixture.filePath, line: 0, content: '', contextBefore: '', contextAfter: '' }]
          : [],
    };
  if (url.pathname === '/api/workspace/file')
    return {
      path: url.searchParams.get('path') ?? fixture.filePath,
      content: '',
      sha256: fixture.revision.slice('sha256:'.length),
      size: fixture.bytes.length,
      mime: fixture.mime,
      binary: true,
      truncated: false,
    };
  if (url.pathname === '/api/preview/status') return { available: false, gatewayPort: 0 };
  if (url.pathname === `/api/threads/${THREAD_ID}/artifacts`) return { threadId: THREAD_ID, artifacts: [] };
  return {};
}

export {
  IMAGE_FIXTURE,
  NEXT_BIN,
  REVIEW_ID,
  SOURCE_REVISION,
  THREAD_ID,
  WEB_ROOT,
  WORKTREE_ID,
  createReviewState,
  findFreePort,
  fixtureForApi,
  json,
  readProductionBuildId,
  reviewView,
  stopServer,
  waitForPage,
};
