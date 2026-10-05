import type { FastifyInstance } from 'fastify';
import { projectCompanionDecisions } from './companion-decision-projection.js';
import {
  approvalsSourceSchema,
  assertDecisionOwner,
  type DecisionSourceRead,
  needsMeSourceSchema,
} from './companion-decision-sources.js';

/** Each source is independently read and fenced to this request's principal. No cache or writer. */
export async function readCompanionDecisionProjection(
  app: FastifyInstance,
  userId: string,
  page: { offset: number; limit: number },
) {
  const config = {
    approvals: {
      url: '/api/approval-hub/pending',
      coverage: 'all_registered_F246_producers' as const,
      parse(value: unknown) {
        const body = approvalsSourceSchema.parse(value);
        assertDecisionOwner(body.items, [], userId);
        return body;
      },
    },
    needsMe: {
      url: '/api/entrusted-work/needs-me',
      coverage: 'current_linked_F310_five_producers' as const,
      parse(value: unknown) {
        const body = needsMeSourceSchema.parse(value);
        assertDecisionOwner([], body.ownerReads, userId);
        return body;
      },
    },
  };
  const read = async (kind: 'approvals' | 'needsMe') => {
    const startedAt = Date.now();
    const { url, coverage, parse } = config[kind];
    let status: DecisionSourceRead['status'] = 'unavailable';
    let exhaustiveness: DecisionSourceRead['exhaustiveness'] = 'unknown';
    let body: unknown;
    try {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-cat-cafe-user': userId },
      });
      status = sourceStatus(response.statusCode);
      if (response.statusCode === 200) {
        const parsed = parse(response.json());
        body = parsed;
        exhaustiveness = parsed.coverage?.state ?? 'unknown';
        status = 'available';
      }
    } catch {
      body = undefined;
    }
    return {
      body: status === 'available' ? body : undefined,
      state: { status, coverage, exhaustiveness, startedAt, observedAt: Date.now() } satisfies DecisionSourceRead,
    };
  };
  const [approvals, needsMe] = await Promise.all([read('approvals'), read('needsMe')]);
  return projectCompanionDecisions(
    approvals.body ?? { items: [] },
    needsMe.body ?? { ownerReads: [] },
    userId,
    page,
    Date.now(),
    { approvals: approvals.state, needsMe: needsMe.state },
  );
}

function sourceStatus(code: number): DecisionSourceRead['status'] {
  if (code === 200) return 'invalid';
  if (code === 401) return 'unauthenticated';
  if (code === 403) return 'forbidden';
  return 'unavailable';
}

/** Explicit adoption keeps existing F317 readers on their available-only wire contract. */
export function companionDecisionWireResponse(result: ReturnType<typeof projectCompanionDecisions>, view?: 'unified') {
  if (view !== 'unified' && result.status !== 'available') {
    return {
      statusCode: 503,
      body: {
        status: 'unavailable' as const,
        scope: result.scope,
        observedAt: result.observedAt,
        sources: result.sources,
      },
    };
  }
  return { statusCode: result.status === 'unavailable' ? 503 : 200, body: result };
}
