import { randomBytes } from 'node:crypto';
import type {} from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const COOKIE_NAME = 'cat_cafe_session';
const TOKEN_BYTES = 32;

declare module 'fastify' {
  interface FastifyRequest {
    sessionUserId?: string;
  }
}

const DEFAULT_MAX_SESSIONS = 10_000;

export class SessionStore {
  private sessions = new Map<string, string>();
  private maxSessions: number;

  constructor(opts?: { maxSessions?: number }) {
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  create(userId: string): string {
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.sessions.set(token, userId);
    return token;
  }

  validate(token: string): string | null {
    if (!token) return null;
    return this.sessions.get(token) ?? null;
  }
}

const globalStore = new SessionStore();

function sessionAuth(app: FastifyInstance, _opts: Record<string, never>, done: () => void) {
  app.decorateRequest('sessionUserId', undefined);

  app.addHook('onRequest', (request, _reply, next) => {
    const token = request.cookies?.[COOKIE_NAME];
    if (token) {
      const userId = globalStore.validate(token);
      if (userId) {
        request.sessionUserId = userId;
      }
    }
    next();
  });

  done();
}

export const sessionAuthPlugin = fp(sessionAuth, {
  name: 'session-auth',
  dependencies: ['@fastify/cookie'],
});

function sessionRoutePlugin(app: FastifyInstance, _opts: Record<string, never>, done: () => void) {
  app.get('/api/session', async (request, reply) => {
    if (request.sessionUserId) {
      return { userId: request.sessionUserId };
    }

    const fwdProto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim().toLowerCase();
    const isSecure = request.protocol === 'https' || fwdProto === 'https';

    const token = globalStore.create('default-user');
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      ...(isSecure ? { secure: true } : {}),
    });
    return { userId: 'default-user' };
  });

  done();
}

export const sessionRoute = fp(sessionRoutePlugin, {
  name: 'session-route',
  dependencies: ['session-auth'],
});
