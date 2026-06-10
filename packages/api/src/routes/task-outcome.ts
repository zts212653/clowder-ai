/**
 * F192 Phase G — Task Outcome Episode API routes.
 *
 * Routes:
 *   POST /api/task-outcome/cancel   — Record a permission cancel signal
 *   POST /api/task-outcome/magic-word — Record a magic word signal
 *   POST /api/task-outcome/a1        — Record an A1 world truth event
 *   GET  /api/task-outcome/episodes/:threadId — List episodes for a thread
 *   GET  /api/task-outcome/episode/:episodeId — Get a single assembled episode
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CANCEL_REASONS } from '../infrastructure/harness-eval/task-outcome/task-outcome-episode.js';
import {
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
  handlePermissionCancel,
  handleUpdateTerminalState,
} from '../infrastructure/harness-eval/task-outcome/task-outcome-routes.js';
import type { TaskOutcomeEpisodeStore } from '../infrastructure/harness-eval/task-outcome/task-outcome-store.js';

export interface TaskOutcomeRoutesOptions {
  store: TaskOutcomeEpisodeStore;
}

const cancelSchema = z.object({
  toolName: z.string().min(1),
  paramsSummary: z.string().max(500).optional(),
  reason: z.enum(CANCEL_REASONS).optional(),
  catId: z.string().min(1),
  threadId: z.string().min(1),
  sessionId: z.string().optional(),
});

const terminalStateSchema = z.object({
  episodeId: z.string().min(1),
  terminalState: z.enum(['completed', 'abandoned', 'escalated_cvo', 'corrected_then_completed']),
});

const a1Schema = z.object({
  type: z.enum(['merge', 'revert', 'test_pass', 'test_fail', 'build_pass', 'build_fail']),
  ref: z.string().min(1),
  outcome: z.enum(['success', 'failure']),
  threadId: z.string().min(1),
});

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

export const taskOutcomeRoutes: FastifyPluginAsync<TaskOutcomeRoutesOptions> = async (app, opts) => {
  const { store } = opts;

  app.post('/api/task-outcome/cancel', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    return handlePermissionCancel(store, parsed.data);
  });

  // F227 归一: DEPRECATED. Magic words are now captured automatically by Event
  // Memory (onMagicWordDetected → Event store, the single source of truth). This
  // manual route no longer writes any signal — it must not be a second truth-write
  // path (砚砚 acceptance: deprecated + no inline truth).
  app.post('/api/task-outcome/magic-word', async (_request, reply) => {
    reply.status(410);
    return {
      error: 'deprecated',
      message:
        'POST /api/task-outcome/magic-word is deprecated (F227 归一). Magic words are auto-captured via Event Memory; this route no longer writes signals.',
    };
  });

  app.post('/api/task-outcome/a1', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const parsed = a1Schema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    return handleA1WorldTruth(store, parsed.data);
  });

  app.post('/api/task-outcome/terminal-state', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const parsed = terminalStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const result = handleUpdateTerminalState(store, parsed.data);
    if (!result) {
      reply.status(404);
      return { error: 'Episode not found' };
    }
    return result;
  });

  app.get('/api/task-outcome/episodes/:threadId', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { threadId } = request.params as { threadId: string };
    return handleListEpisodes(store, threadId);
  });

  app.get('/api/task-outcome/episode/:episodeId', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { episodeId } = request.params as { episodeId: string };
    const result = handleGetEpisode(store, episodeId);
    if (!result) return { error: 'Episode not found' };
    return result;
  });
};
