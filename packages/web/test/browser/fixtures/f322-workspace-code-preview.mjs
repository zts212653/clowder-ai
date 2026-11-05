// Manual author preview: the actual Next thread/ChatContainer/Workspace owners, isolated fixture HTTP.
// No Redis, account credentials, Message writes, or production permission claims.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_REQUEST_DIAGNOSTIC_HEADER } from '@cat-cafe/shared';
import { OTHER_THREAD_ID, realSurfaceApiResponse, THREAD_ID, WORKTREE_ID } from '../f307-real-surface-fixtures.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const web = path.join(repo, 'packages/web');
const port = Number(process.argv[2] ?? 5323);
assert.ok(Number.isInteger(port) && port >= 1024 && port < 65535);
assert.ok(![3001, 3002, 3011, 3012, 4111, 6397, 6398, 6399].includes(port));
// Isolated text-draft protocol for these two synthetic threads only. This is
// process-local fixture state, not production persistence or authentication evidence.
const composerDrafts = new Map();
function composerDraftResponse(threadId, method, body) {
  if (![THREAD_ID, OTHER_THREAD_ID].includes(threadId))
    return { status: 404, body: { error: 'fixture_thread_unavailable' } };
  const current = composerDrafts.get(threadId) ?? null;
  const actualRevision = current?.revision ?? 0;
  if (method === 'GET') return { body: { draft: current, revision: actualRevision } };
  if (method !== 'PUT' && method !== 'DELETE') return { status: 405, body: { error: 'fixture_method_unavailable' } };
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'invalid_fixture_draft' } };
  }
  if (
    !input ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    Object.keys(input).some((key) => !['expectedRevision', ...(method === 'PUT' ? ['text'] : [])].includes(key)) ||
    (method === 'PUT' && (typeof input.text !== 'string' || input.text.length > 100000))
  )
    return { status: 400, body: { error: 'invalid_fixture_text_draft' } };
  if (input.expectedRevision !== actualRevision)
    return { status: 409, body: { code: 'DRAFT_REVISION_MISMATCH', actualRevision } };
  const draft = {
    version: 1,
    ownerUserId: 'fixture-owner',
    threadId,
    revision: actualRevision + 1,
    text: method === 'PUT' ? input.text : '',
    updatedAt: Date.now(),
  };
  composerDrafts.set(threadId, draft);
  return { body: method === 'PUT' ? { draft } : { cleared: true, revision: draft.revision } };
}

const api = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', `http://127.0.0.1:${port}`);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', `content-type,${CLIENT_REQUEST_DIAGNOSTIC_HEADER}`);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url, `http://127.0.0.1:${port + 1}`);
  if (url.pathname === '/browser-owner-probe') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(await readFile(path.join(web, 'test/browser/fixtures/f322-browser-owner.html'), 'utf8'));
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65536) {
      response.writeHead(413);
      response.end();
      return;
    }
  }
  const fixture = realSurfaceApiResponse(
    { url: () => url.href, method: () => request.method, postData: () => body },
    false,
  );
  const draftRoute = /^\/api\/threads\/([^/]+)\/composer-draft$/.exec(url.pathname);
  if (draftRoute) Object.assign(fixture, composerDraftResponse(draftRoute[1], request.method, body));
  if (url.pathname === '/api/preview/status') fixture.body = { available: true, gatewayPort: port + 1 };
  if (url.pathname === '/api/preview/target-health')
    fixture.body = { reachable: Number(url.searchParams.get('port')) === port + 1 };
  if (url.pathname === '/api/workspace/tree')
    fixture.body = {
      tree: [
        { name: 'DESIGN.md', path: 'DESIGN.md', type: 'file' },
        {
          name: 'WorkspaceFileViewer.tsx',
          path: 'packages/web/src/components/workspace/WorkspaceFileViewer.tsx',
          type: 'file',
        },
      ],
    };
  if (url.pathname === '/api/workspace/worktrees')
    fixture.body = {
      worktrees: [{ id: WORKTREE_ID, root: repo, branch: 'feat/f322-workspace-code-group', head: 'author-preview' }],
    };
  if (url.pathname === '/api/workspace/file') {
    const file = url.searchParams.get('path');
    const allowed = ['DESIGN.md', 'packages/web/src/components/workspace/WorkspaceFileViewer.tsx'];
    if (!allowed.includes(file)) {
      fixture.status = 404;
      fixture.body = { error: 'fixture_file_unavailable' };
    } else {
      const content = await readFile(path.join(repo, file), 'utf8');
      fixture.body = {
        path: file,
        content,
        size: Buffer.byteLength(content),
        sha256: 'preview-source',
        mime: 'text/plain',
        truncated: false,
      };
    }
  }
  response.writeHead(fixture.status ?? 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(fixture.body));
});
api.listen(port + 1, '127.0.0.1');
await once(api, 'listening');
const dist = '.next-test-f322-code-preview';
const tsconfig = 'tsconfig.next-test-f322-code-preview.json';
await writeFile(
  path.join(web, tsconfig),
  JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { noEmit: true },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${dist}/types/**/*.ts`],
    exclude: ['node_modules'],
  }),
);
const next = spawn(
  process.execPath,
  [
    path.join(web, 'scripts/sync-vendor-assets.mjs'),
    '--watch',
    '--',
    process.execPath,
    path.join(repo, 'node_modules/next/dist/bin/next'),
    'dev',
    '-H',
    '127.0.0.1',
    '-p',
    String(port),
  ],
  {
    cwd: web,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port + 1}`,
      API_SERVER_PORT: String(port + 1),
      CAT_CAFE_WEB_TEST_DIST_DIR: dist,
      CAT_CAFE_WEB_TEST_TSCONFIG: tsconfig,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
);
console.log(
  JSON.stringify({
    kind: 'author-real-host-fixture',
    origin: `http://127.0.0.1:${port}`,
    path: `/thread/${THREAD_ID}?shell=v2`,
    apiPort: port + 1,
    productionData: false,
  }),
);
next.on('exit', (code) => {
  api.close();
  process.exit(code ?? 1);
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    next.kill(signal);
    api.close();
  });
