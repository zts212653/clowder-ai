import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type BrokenClaudeThinkingSession,
  type ClaudeThinkingRescueRunResult,
  type ClaudeThinkingRescueScanResult,
  type ClaudeThinkingRescueTarget,
  findBrokenClaudeThinkingSessions as findBrokenClaudeThinkingSessionsDefault,
  rescueClaudeThinkingSessions as rescueClaudeThinkingSessionsDefault,
} from '../domains/cats/services/session/ClaudeThinkingRescue.js';
import { resolveUserId } from '../utils/request-identity.js';

const rescueBodySchema = z.object({
  sessionIds: z.array(z.string().trim().min(1)).min(1),
});

export interface ClaudeRescueRoutesOptions {
  findBrokenClaudeThinkingSessions?: () => Promise<ClaudeThinkingRescueScanResult>;
  rescueClaudeThinkingSessions?: (body: {
    sessionIds: string[];
    targets: ClaudeThinkingRescueTarget[];
  }) => Promise<ClaudeThinkingRescueRunResult>;
}

function sortSessions(sessions: BrokenClaudeThinkingSession[]): BrokenClaudeThinkingSession[] {
  return [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export const claudeRescueRoutes: FastifyPluginAsync<ClaudeRescueRoutesOptions> = async (app, opts) => {
  const findBrokenClaudeThinkingSessions =
    opts.findBrokenClaudeThinkingSessions ?? findBrokenClaudeThinkingSessionsDefault;
  const rescueClaudeThinkingSessions =
    opts.rescueClaudeThinkingSessions ?? (async ({ targets }) => rescueClaudeThinkingSessionsDefault({ targets }));

  app.get('/api/claude-rescue/sessions', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const result = await findBrokenClaudeThinkingSessions();
    return { sessions: sortSessions(result.sessions) };
  });

  app.post('/api/claude-rescue/rescue', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const parsed = rescueBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    const body = parsed.data;
    const scan = await findBrokenClaudeThinkingSessions();
    const selectedTargets = scan.sessions
      .filter((target) => body.sessionIds.includes(target.sessionId))
      .map((target) => ({
        sessionId: target.sessionId,
        transcriptPath: target.transcriptPath,
      }));
    if (selectedTargets.length === 0) {
      reply.status(400);
      return { error: 'No rescue targets matched the requested sessionIds' };
    }

    return rescueClaudeThinkingSessions({
      sessionIds: body.sessionIds,
      targets: selectedTargets,
    });
  });
};
