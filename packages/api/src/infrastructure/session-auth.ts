import { randomBytes } from 'node:crypto';
import type {} from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';

const COOKIE_NAME = 'cat_cafe_session';
const TOKEN_BYTES = 32;
const DEFAULT_USER_ID = 'default-user';
const UNPAIRED_USER_ID = 'unpaired-user';

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

export interface SessionRouteOptions {
  ownerUserId?: string;
}

function sessionRoutePlugin(app: FastifyInstance, opts: SessionRouteOptions, done: () => void) {
  const ownerUserId = (opts.ownerUserId ?? DEFAULT_USER_ID).trim();
  if (!ownerUserId) throw new Error('[session-auth] ownerUserId must not be blank');

  app.get('/api/session', async (request, reply) => {
    if (request.sessionUserId) {
      return { userId: request.sessionUserId };
    }

    const fwdProto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim().toLowerCase();
    const isSecure = request.protocol === 'https' || fwdProto === 'https';
    const bootstrapUserId = isDirectLoopbackRequest(request)
      ? ownerUserId
      : ownerUserId === DEFAULT_USER_ID
        ? UNPAIRED_USER_ID
        : DEFAULT_USER_ID;

    const token = globalStore.create(bootstrapUserId);
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      ...(isSecure ? { secure: true } : {}),
    });
    return { userId: bootstrapUserId };
  });

  done();
}

export const sessionRoute = fp(sessionRoutePlugin, {
  name: 'session-route',
  dependencies: ['session-auth'],
});
