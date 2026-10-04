import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { companionDecisionWireResponse, readCompanionDecisionProjection } from './companion-decision-read-service.js';

const pageSchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    view: z.literal('unified').optional(),
  })
  .strict();

type Activity = { kind: string; activity?: string; startedAt: number; occupancy: 'owned' | 'foreign' };
type WorkGroup = { threadId: string; threadTitle: string | null; catId: string; activities: Activity[] };

function unavailable(reply: FastifyReply, source: string, observedAt: number) {
  return reply.code(503).send({ status: 'unavailable', source, scope: 'host_active_project', observedAt });
}

/** Pure projection of F295's canonical response; control handles never leave this boundary. */
export function projectCompanionRunningWork(source: unknown, expectedProjectPath: string, observedAt: number) {
  const body = z
    .object({
      projectPath: z.string(),
      executions: z.array(
        z
          .object({
            threadId: z.string(),
            threadTitle: z.string().nullable(),
            catId: z.string(),
            kind: z.enum(['live_invocation', 'managed_command']),
            activity: z.string().optional(),
            startedAt: z.number(),
            cancelability: z
              .object({ state: z.enum(['cancelable', 'not_cancelable']), reason: z.string().optional() })
              .passthrough(),
          })
          .passthrough(),
      ),
    })
    .parse(source);
  if (body.projectPath !== expectedProjectPath) throw new Error('Active project identity mismatch');
  const byGroup = new Map<string, WorkGroup>();
  for (const execution of body.executions) {
    const key = JSON.stringify([execution.threadId, execution.catId]);
    let group = byGroup.get(key);
    if (!group) {
      group = {
        threadId: execution.threadId,
        threadTitle: execution.threadTitle,
        catId: execution.catId,
        activities: [],
      };
      byGroup.set(key, group);
    }
    group.activities.push({
      kind: execution.kind,
      ...(execution.activity ? { activity: execution.activity } : {}),
      startedAt: execution.startedAt,
      occupancy: execution.cancelability.reason === 'foreign_principal' ? 'foreign' : 'owned',
    });
  }
  return {
    status: 'available' as const,
    scope: 'host_active_project' as const,
    projectPath: body.projectPath,
    observedAt,
    executionCount: body.executions.length,
    workGroupCount: byGroup.size,
    workingThreadCount: new Set(body.executions.map((execution) => execution.threadId)).size,
    groups: [...byGroup.values()],
  };
}

export function registerCompanionWorkReadRoutes(app: FastifyInstance, projectPath: string): void {
  app.get('/api/callbacks/companion/running-work', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!z.object({}).strict().safeParse(request.query).success)
      return reply.code(400).send({ error: 'No selectors accepted' });
    const observedAt = Date.now();
    if (!projectPath) return unavailable(reply, 'F295', observedAt);
    const response = await app.inject({
      method: 'GET',
      url: `/api/executions/active?projectPath=${encodeURIComponent(projectPath)}`,
      headers: { 'x-cat-cafe-user': record.userId },
    });
    if (response.statusCode !== 200) return unavailable(reply, 'F295', observedAt);
    try {
      return projectCompanionRunningWork(response.json(), projectPath, observedAt);
    } catch {
      return unavailable(reply, 'F295', observedAt);
    }
  });

  app.get('/api/callbacks/companion/decisions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const page = pageSchema.safeParse(request.query);
    if (!page.success) return reply.code(400).send({ error: 'Invalid page' });
    const { offset, limit, view } = page.data;
    const result = await readCompanionDecisionProjection(app, record.userId, { offset, limit });
    const response = companionDecisionWireResponse(result, view);
    return reply.code(response.statusCode).send(response.body);
  });
}
