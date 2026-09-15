import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';

const programId = `evolution-program:${'a'.repeat(32)}`;
const projection = { program: { programId, workspaceId: 'user:operator' }, blockers: [], nextAction: {} };
const origin = { threadId: 'thread-original', title: '让审阅更贴近原始需求', createdByCatId: 'codex-sol' };
const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(userId) {
  const reads = [];
  const app = Fastify();
  if (userId)
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = userId;
    });
  await app.register(capabilityEvolutionProgramRoutes, {
    service: { get: async () => projection, list: async () => [projection] },
    resolveOrigin: async (program) => {
      reads.push(program.programId);
      return origin;
    },
  });
  apps.push(app);
  return { app, reads };
}

describe('F311 source conversation is an authorized live read', () => {
  it('projects the same verified origin into the list, detail and promoted tab', async () => {
    const { app, reads } = await setup('operator');
    const detail = await app.inject(`/api/capability-evolution/programs/${programId}`);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().origin, origin);
    assert.equal(detail.json().program.displayName, undefined);
    assert.equal(detail.headers['cache-control'], 'private, no-store');
    const list = await app.inject('/api/capability-evolution/programs');
    assert.deepEqual(list.json().programs[0].origin, origin);
    assert.equal(list.json().surfaces[0].title, '来自「让审阅更贴近原始需求」');
    assert.equal(list.headers['cache-control'], 'private, no-store');
    assert.equal(reads.length, 2);
  });
  it('never opens a source before authentication or outside the Program workspace', async () => {
    for (const userId of [undefined, 'other']) {
      const { app, reads } = await setup(userId);
      const detail = await app.inject(`/api/capability-evolution/programs/${programId}`);
      assert.equal(detail.statusCode, userId ? 404 : 401);
      const list = await app.inject('/api/capability-evolution/programs');
      assert.equal(list.statusCode, userId ? 200 : 401);
      if (userId) assert.deepEqual(list.json(), { programs: [], surfaces: [] });
      assert.deepEqual(reads, []);
    }
  });
});
