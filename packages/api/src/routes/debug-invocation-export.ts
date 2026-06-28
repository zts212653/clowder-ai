import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

const exportBodySchema = z.object({
  kind: z.enum(['events', 'bubbleTimeline']).default('events'),
  label: z.string().max(80).optional(),
  dump: z.object({
    meta: z.object({
      generatedAt: z.number(),
      count: z.number(),
      enabled: z.boolean(),
      size: z.number(),
      rawThreadId: z.boolean(),
      marker: z.enum(['MASKED', 'RAW']),
      expiresAt: z.number().nullable(),
    }),
    events: z.array(z.record(z.string(), z.unknown())),
  }),
});

export interface DebugInvocationExportRoutesOptions {
  projectRoot?: string;
}

function sanitizeLabel(input?: string): string {
  const normalized = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'debug';
}

export const debugInvocationExportRoutes: FastifyPluginAsync<DebugInvocationExportRoutesOptions> = async (
  app,
  opts,
) => {
  app.post('/api/debug/invocation-events/export', async (request, reply) => {
    const auth = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Debug export writes',
      ownerErrorMessage: 'Debug export writes can only be performed by the configured owner',
    });
    if (!auth.ok) {
      return reply.send({ ...auth.response, code: 'AUTH_REQUIRED' });
    }

    const parsed = exportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    }

    const root = opts.projectRoot ?? findMonorepoRoot(process.cwd());
    const runtimeDir = join(root, 'docs', 'runtime');
    await mkdir(runtimeDir, { recursive: true });

    const label = sanitizeLabel(parsed.data.label);
    const fileName = `invocation-events-${Date.now()}-${label}-${randomUUID().slice(0, 8)}.json`;
    const absPath = join(runtimeDir, fileName);

    const payload = {
      exportedAt: Date.now(),
      exportedBy: auth.userId,
      kind: parsed.data.kind,
      dump: parsed.data.dump,
    };

    await writeFile(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

    return {
      ok: true,
      path: `docs/runtime/${fileName}`,
      count: parsed.data.dump.events.length,
    };
  });
};
