import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../../src/infrastructure/session-auth.js';
import { registerConnectionDiagnostics } from '../../src/routes/connection-diagnostics.js';

export async function connectionDiagnosticsFixture(onRecord?: (record: Record<string, unknown>) => void) {
  const records: Record<string, unknown>[] = [];
  const app = Fastify({
    forceCloseConnections: true,
    logger: {
      level: 'info',
      stream: {
        write(line: string) {
          const record = JSON.parse(line) as Record<string, unknown>;
          records.push(record);
          onRecord?.(record);
        },
      },
    },
  });
  await app.register(cors, { origin: /^http:\/\/127\.0\.0\.1(?::\d+)?$/, credentials: true, maxAge: 600 });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  registerConnectionDiagnostics(app, 10);
  return { app, records };
}
