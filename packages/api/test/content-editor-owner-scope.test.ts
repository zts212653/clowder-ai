import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCollaborativeContentRoutes } from '../src/routes/collaborative-content-routes.js';
import { registerWorkspaceContentEditorRoutes } from '../src/routes/workspace-content-editor-routes.js';

test('all document routes reject a different authenticated owner before reading or issuing authority', async () => {
  const app = Fastify();
  let calls = 0;
  const forbidden = async (): Promise<never> => {
    calls++;
    throw new Error('owner boundary crossed');
  };
  registerCollaborativeContentRoutes(app, {
    ownerUserId: 'operator',
    bridge: { load: forbidden, settle: forbidden },
    sessions: { issue: forbidden, prepareResume: forbidden, resume: forbidden, closeRef: forbidden },
    surfaces: { resolve: forbidden },
  });
  registerWorkspaceContentEditorRoutes(app, { ownerUserId: 'operator', workspace: { open: forbidden } });
  try {
    const ref = `editor-session:${'a'.repeat(64)}`;
    for (const request of [
      {
        method: 'POST' as const,
        url: '/api/collaborative-content/editor-sessions',
        payload: { contentRef: 'private-document' },
      },
      { method: 'POST' as const, url: `/api/collaborative-content/editor-sessions/${ref}/resume`, payload: {} },
      { method: 'DELETE' as const, url: `/api/collaborative-content/editor-sessions/${ref}` },
      {
        method: 'POST' as const,
        url: '/api/collaborative-content/editor-bridge',
        payload: {
          v: 1,
          sessionToken: `editor_${'a'.repeat(40)}`,
          operation: 'content.load',
          payload: {},
        },
      },
      {
        method: 'POST' as const,
        url: '/api/workspace/content-editor',
        payload: { worktreeId: 'main', path: 'private.docx' },
      },
    ]) {
      const response = await app.inject({ ...request, headers: { 'x-cat-cafe-user': 'other-owner' } });
      assert.equal(response.statusCode, 403, request.url);
      assert.equal(response.json().error.code, 'content_access_denied');
      const remote = await app.inject({
        ...request,
        remoteAddress: '192.0.2.10',
        headers: { 'x-cat-cafe-user': 'operator' },
      });
      assert.equal(remote.statusCode, 401, `${request.url}: remote header cannot impersonate the owner`);
    }
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});
