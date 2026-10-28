import type { FastifyInstance } from 'fastify';
import type { MemberCanonService } from '../domains/collaborative-content/asset-canon/member-service.js';
import { directContentHuman } from './content-modification-routes.js';

/** All catalog responses, including a profile-only PATCH, read the one canonical avatar slot. */
export function registerMemberCanonResponse(app: FastifyInstance, read: () => MemberCanonService | undefined) {
  app.addHook('preSerialization', async (request, _reply, payload: unknown) => {
    const service = read();
    if (!service || !payload || typeof payload !== 'object') return payload;
    const body = payload as Record<string, unknown>;
    const human = directContentHuman(request);
    const principal = human ? { ...human, threadId: '' } : null;
    const project = async (value: unknown) => {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return value;
      return { ...value, ...(await service.project(value.id, principal)) };
    };
    if (Array.isArray(body.cats)) return { ...body, cats: await Promise.all(body.cats.map(project)) };
    if (body.cat) return { ...body, cat: await project(body.cat) };
    return payload;
  });
}
