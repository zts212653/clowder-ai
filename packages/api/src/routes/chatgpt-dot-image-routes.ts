import type { FastifyInstance } from 'fastify';
import type { DotImageService } from '../domains/cats/services/cloud-bridge/dot/DotImageService.js';

export function registerDotImageRoutes(app: FastifyInstance, images: DotImageService) {
  app.get<{ Params: { file: string } }>('/api/plugins/chatgpt-dot/images/:file', async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send({ error: 'authentication_required' });
    const match = /^(dot_img_[a-f0-9]{64})\.png$/.exec(request.params.file);
    if (!match?.[1]) return reply.code(404).send();
    try {
      const { bytes, asset } = await images.read(match[1], request.sessionUserId);
      reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type('image/png');
      reply.header('content-disposition', `inline; filename="${asset.id}.png"`);
      return reply.send(bytes);
    } catch {
      return reply.code(404).send({ error: 'image_unavailable' });
    }
  });
}
