import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { f317MeetingShareRoutes } from '../src/routes/f317-meeting-share.js';

test('meeting share route invokes prototype methods on the production-shaped Host, rather than object-spreading them away', async (t) => {
  class Host {
    async observeCall(userId: string) {
      return {
        userId,
        callId: 'call-1',
        threadId: 'live-thread',
        catId: 'codex61-sol',
        generation: 1,
        state: 'talking' as const,
      };
    }
    async attach() {}
    async detach() {}
    isAttached() {
      return false;
    }
  }
  const app = Fastify();
  const threads = new ThreadStore();
  const thread = await threads.create('default-user');
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'default-user';
  });
  await app.register(f317MeetingShareRoutes, {
    ownerUserId: 'default-user',
    threadStore: threads,
    host: new Host(),
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          running: true,
          lifecycle_state: 'running',
          paused: false,
          thread_id: thread.id,
          meeting_id: 'meeting-1',
          started_at: 100,
          inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running' }],
        }),
      ),
  });
  t.after(() => app.close());
  const result = await app.inject({ method: 'GET', url: '/api/concierge/meeting-share' });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().kind, 'available');
});
