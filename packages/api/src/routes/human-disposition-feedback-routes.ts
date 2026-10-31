import { humanDispositionInteractionKindSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  HumanDispositionLedger,
  HumanDispositionLedgerCursorError,
  HumanDispositionLedgerInvariantError,
  type HumanDispositionLedgerQueryOptions,
} from '../domains/human-disposition/HumanDispositionLedger.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const exactReferenceSchema = z.string().trim().min(1).max(500);
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).max(4_096).optional(),
    interactionKind: humanDispositionInteractionKindSchema.optional(),
    subjectRef: exactReferenceSchema.optional(),
  })
  .strict();

const routeCursorSchema = z
  .object({
    decidedAt: z.number().finite().nonnegative(),
    sourceRef: exactReferenceSchema,
    interactionKind: humanDispositionInteractionKindSchema.optional(),
    subjectRef: exactReferenceSchema.optional(),
  })
  .strict();

type RouteCursor = z.infer<typeof routeCursorSchema>;

export interface HumanDispositionFeedbackRouteDeps {
  ledger: HumanDispositionLedger | null;
}

interface EpisodeQueryContext {
  ownerUserId: string;
  ledger: HumanDispositionLedger;
  query: z.infer<typeof querySchema>;
  options: HumanDispositionLedgerQueryOptions;
}

interface RouteOutcome {
  status: number;
  body: unknown;
}

function decodeCursor(value: string): RouteCursor {
  try {
    return routeCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new HumanDispositionLedgerCursorError();
  }
}

function encodeCursor(cursor: RouteCursor): string {
  return Buffer.from(JSON.stringify(routeCursorSchema.parse(cursor)), 'utf8').toString('base64url');
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function pageOptions(input: z.infer<typeof querySchema>): HumanDispositionLedgerQueryOptions {
  const decoded = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (
    decoded &&
    (!sameOptional(decoded.interactionKind, input.interactionKind) ||
      !sameOptional(decoded.subjectRef, input.subjectRef))
  ) {
    throw new HumanDispositionLedgerCursorError();
  }
  return {
    limit: input.limit,
    ...(decoded ? { cursor: { decidedAt: decoded.decidedAt, sourceRef: decoded.sourceRef } } : {}),
    ...(input.interactionKind ? { interactionKind: input.interactionKind } : {}),
    ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
  };
}

function parseEpisodeQuery(
  request: FastifyRequest,
  deps: HumanDispositionFeedbackRouteDeps,
): EpisodeQueryContext | RouteOutcome {
  const ownerUserId = resolveStrictUserId(request);
  if (!ownerUserId) return { status: 401, body: { error: 'identity_required' } };
  const query = querySchema.safeParse(request.query);
  if (!query.success) {
    return { status: 400, body: { error: 'invalid_request', details: query.error.issues } };
  }
  if (!deps.ledger) return { status: 503, body: { error: 'durable_store_unavailable' } };
  try {
    return {
      ownerUserId,
      ledger: deps.ledger,
      query: query.data,
      options: pageOptions(query.data),
    };
  } catch (error) {
    if (error instanceof HumanDispositionLedgerCursorError) {
      return { status: 400, body: { error: 'invalid_cursor' } };
    }
    throw error;
  }
}

function encodeNextCursor(
  cursor: { decidedAt: number; sourceRef: string } | undefined,
  query: z.infer<typeof querySchema>,
): string | undefined {
  if (!cursor) return undefined;
  return encodeCursor({
    ...cursor,
    ...(query.interactionKind ? { interactionKind: query.interactionKind } : {}),
    ...(query.subjectRef ? { subjectRef: query.subjectRef } : {}),
  });
}

async function loadEpisodeQuery(request: FastifyRequest, context: EpisodeQueryContext): Promise<RouteOutcome> {
  try {
    const page = await context.ledger.query(context.ownerUserId, context.options);
    const nextCursor = encodeNextCursor(page.nextCursor, context.query);
    return {
      status: 200,
      body: {
        entries: page.entries,
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  } catch (error) {
    if (error instanceof HumanDispositionLedgerCursorError) {
      return { status: 400, body: { error: 'invalid_cursor' } };
    }
    request.log.error(
      { error, invariant: error instanceof HumanDispositionLedgerInvariantError },
      'F281 disposition ledger query invariant failed',
    );
    return { status: 500, body: { error: 'ledger_invariant' } };
  }
}

export function registerHumanDispositionFeedbackRoutes(
  app: FastifyInstance,
  deps: HumanDispositionFeedbackRouteDeps,
): void {
  app.get('/api/human-disposition-feedback/episodes', async (request, reply) => {
    const parsed = parseEpisodeQuery(request, deps);
    const outcome = 'status' in parsed ? parsed : await loadEpisodeQuery(request, parsed);
    reply.status(outcome.status);
    return outcome.body;
  });
}
