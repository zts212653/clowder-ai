import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

type DotImageReadResult = { bytes: Buffer; asset: { id: string } } | { stream: Readable; asset: { id: string } };

export function registerDotImageRoutes(
  app: FastifyInstance,
  images: { read(id: string, ownerUserId: string): Promise<DotImageReadResult> },
) {
  app.get<{ Params: { file: string } }>('/api/plugins/chatgpt-dot/images/:file', async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send({ error: 'authentication_required' });
    const match = /^(dot_img_[a-f0-9]{64})\.png$/.exec(request.params.file);
    if (!match?.[1]) return reply.code(404).send();
    try {
      const result = await images.read(match[1], request.sessionUserId);
      reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type('image/png');
      reply.header('content-disposition', `inline; filename="${result.asset.id}.png"`);
      return reply.send('stream' in result ? result.stream : result.bytes);
    } catch {
      return reply.code(404).send({ error: 'image_unavailable' });
    }
  });
}
