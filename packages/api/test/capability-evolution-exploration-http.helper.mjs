import { afterEach } from 'node:test';
import Fastify from 'fastify';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';
import { id, objectRef } from './capability-evolution-exploration.helper.mjs';

const apps = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
export const explorationUrl = `/api/capability-evolution/programs/${encodeURIComponent(id)}/exploration`;

export async function explorationHttpFixture(user = 'test', workspace = 'user:test') {
  const app = Fastify();
  if (user)
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = user;
      done();
    });
  let reads = 0;
  let writes = 0;
  const unexpectedWrite = () => {
    writes++;
    throw new Error('read must not execute');
  };
  const adapter = Object.fromEntries(
    ['observe', 'permission', 'mutate', 'verify', 'writeback', 'freshOutcome', 'rollback'].map((name) => [
      name,
      unexpectedWrite,
    ]),
  );
  await app.register(capabilityEvolutionProgramRoutes, {
    service: { get: async () => ({ program: { programId: id, workspaceId: workspace, objectRef, sequence: 3 } }) },
    adapterRegistry: {
      resolve: () => {
        reads++;
        return { status: 'resolved', adapter };
      },
    },
  });
  apps.push(app);
  return { app, counts: () => ({ reads, writes }), adapter };
}
