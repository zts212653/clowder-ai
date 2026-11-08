import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PublishedDocumentIndex } from '../domains/memory/PublishedDocumentIndex.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const querySchema = z
  .object({
    anchor: z.string().min(1).max(1000),
    sourceHash: z.string().regex(/^[a-f0-9]{16}$/u),
    startLine: z.coerce.number().int().min(1),
    endLine: z.coerce.number().int().min(1),
    charOffset: z.coerce.number().int().min(0).default(0),
  })
  .refine((input) => input.endLine >= input.startLine && input.endLine - input.startLine < 400);

export function registerPublishedEvidenceSource(
  app: FastifyInstance,
  documents?: PublishedDocumentIndex,
  ownerUserId?: string,
): void {
  app.get('/api/evidence/published-source', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.code(401).send({ error: 'Source identity required' });
    if (!ownerUserId || userId !== ownerUserId) return reply.code(403).send({ error: 'Source is not accessible' });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid source coordinates' });
    if (!documents) return reply.code(503).send({ error: 'Published source unavailable' });
    const { anchor, sourceHash, startLine, endLine, charOffset } = parsed.data;
    try {
      const result = await documents.read(anchor, sourceHash);
      if (result.status !== 'ready')
        return reply.code(result.status === 'source_changed' ? 409 : 404).send({
          error: result.status,
          hint: 'Search again and read the current source; the previous quote was not substituted.',
        });
      const slice = sliceSource(result.content, startLine, endLine, charOffset);
      if (!slice) return reply.code(400).send({ error: 'Slice starts beyond source' });
      return {
        sourceHash,
        sourceVersion: result.revision,
        sourcePath: result.sourcePath,
        authorizationPath: resolve(documents.source.root, 'docs', result.sourcePath),
        ...slice,
      };
    } catch (error) {
      request.log.warn({ err: error }, 'Published source read unavailable');
      return reply.code(503).send({ error: 'Published source read unavailable' });
    }
  });
}

function sliceSource(content: string, startLine: number, endLine: number, charOffset: number) {
  const lines = content.split(/\r?\n/u);
  if (startLine > lines.length || charOffset > lines[startLine - 1].length) return null;
  const selected: string[] = [];
  let available = 20_000;
  let next: { startLine: number; charOffset: number } | undefined;
  for (let line = startLine; line <= Math.min(endLine, lines.length); line++) {
    const offset = line === startLine ? charOffset : 0;
    const prefix = `${line}: `;
    const text = lines[line - 1].slice(offset, offset + Math.max(0, available - prefix.length));
    if (available <= prefix.length) {
      next = { startLine: line, charOffset: offset };
      break;
    }
    selected.push(prefix + text);
    available -= prefix.length + text.length + 1;
    if (offset + text.length < lines[line - 1].length) {
      next = { startLine: line, charOffset: offset + text.length };
      break;
    }
  }
  if (!next && endLine < lines.length) next = { startLine: endLine + 1, charOffset: 0 };
  return { text: selected.join('\n'), ...(next ? { next } : {}) };
}
