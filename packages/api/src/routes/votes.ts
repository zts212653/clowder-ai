/**
 * F079: Vote Routes
 * 投票系统 API: 发起/投票/查询/关闭
 *
 * POST   /api/threads/:threadId/vote/start — 发起投票
 * POST   /api/threads/:threadId/vote       — 投票
 * GET    /api/threads/:threadId/vote       — 查询当前投票
 * DELETE /api/threads/:threadId/vote       — 关闭投票
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createModuleLogger } from '../infrastructure/logger.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const log = createModuleLogger('routes/votes');

import {
  buildVoteTally,
  checkVoteCompletion,
  VOTE_RESULT_SOURCE,
} from '../domains/cats/services/agents/routing/vote-intercept.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, VotingStateV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface VoteRoutesOptions {
  threadStore: IThreadStore;
  socketManager: SocketManager;
  messageStore?: IMessageStore;
}

const startVoteSchema = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(100)).min(2).max(20),
  anonymous: z.boolean().optional().default(false),
  timeoutSec: z.number().int().min(10).max(600).optional().default(120),
  voters: z.array(z.string().min(1).max(50)).min(1).max(20).optional(),
});

const castVoteSchema = z.object({
  option: z.string().min(1).max(100),
});

function resolveUserId(request: import('fastify').FastifyRequest): string {
  return resolveHeaderUserId(request) ?? 'anonymous';
}

/** Phase 2: In-memory timeout timers. Cleared on close/auto-close. Lost on restart (acceptable). */
export const voteTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Close a vote programmatically (timeout or auto-close). */
export async function closeVoteInternal(
  threadId: string,
  threadStore: IThreadStore,
  socketManager: SocketManager,
  messageStore?: IMessageStore,
): Promise<void> {
  const votingState = await threadStore.getVotingState(threadId);
  if (!votingState || votingState.status !== 'active') return;

  const tally = buildVoteTally(votingState.options, votingState.votes);
  const totalVotes = Object.values(votingState.votes).length;
  const fields = votingState.options.map((opt) => ({
    label: opt,
    value: `${tally[opt] ?? 0} 票 (${totalVotes > 0 ? Math.round(((tally[opt] ?? 0) / totalVotes) * 100) : 0}%)`,
  }));

  const publicResult = votingState.anonymous
    ? { ...votingState, status: 'closed' as const, votes: {} as Record<string, string>, tally }
    : { ...votingState, status: 'closed' as const, tally };

  const richBlock = {
    id: `vote-${Date.now()}`,
    kind: 'card' as const,
    v: 1 as const,
    title: `投票结果: ${votingState.question}`,
    bodyMarkdown: votingState.anonymous ? `匿名投票 · ${totalVotes} 票` : `实名投票 · ${totalVotes} 票`,
    tone: 'info' as const,
    fields,
  };

  await threadStore.updateVotingState(threadId, null);
  clearVoteTimer(threadId);
  socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_closed', {
    threadId,
    result: publicResult,
    richBlock,
  });

  // P1-3 fix: persist rich block as system message so it survives refresh
  if (messageStore) {
    try {
      const stored = await messageStore.append({
        userId: votingState.createdBy,
        catId: null,
        content: `投票结果: ${votingState.question}`,
        mentions: [],
        timestamp: Date.now(),
        threadId,
        source: VOTE_RESULT_SOURCE,
        extra: { rich: { v: 1 as const, blocks: [richBlock] } },
      });
      socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          type: 'connector',
          content: stored.content,
          source: VOTE_RESULT_SOURCE,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      });
    } catch (err) {
      log.warn({ threadId, err }, 'Failed to persist vote result');
    }
  }
}

export function clearVoteTimer(threadId: string): void {
  const timer = voteTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    voteTimers.delete(threadId);
  }
}

export const voteRoutes: FastifyPluginAsync<VoteRoutesOptions> = async (app, opts) => {
  const { threadStore, socketManager, messageStore } = opts;

  // POST /api/threads/:threadId/vote/start — start a vote
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/vote/start', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request);
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: '无权操作此对话的投票', code: 'FORBIDDEN' };
    }

    const existing = await threadStore.getVotingState(threadId);
    if (existing && existing.status === 'active') {
      reply.status(409);
      return { error: '已有活跃投票', code: 'VOTE_ALREADY_ACTIVE' };
    }

    const parseResult = startVoteSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const { question, options, anonymous, timeoutSec, voters } = parseResult.data;

    const votingState: VotingStateV1 = {
      v: 1,
      question,
      options,
      votes: {},
      anonymous,
      deadline: Date.now() + timeoutSec * 1000,
      createdBy: userId,
      status: 'active',
      ...(voters ? { voters } : {}),
    };

    await threadStore.updateVotingState(threadId, votingState);

    // Phase 2: Register timeout auto-close
    clearVoteTimer(threadId);
    const timer = setTimeout(() => {
      closeVoteInternal(threadId, threadStore, socketManager, messageStore).catch((err) => {
        log.error({ threadId, err }, 'Timeout auto-close failed');
      });
    }, timeoutSec * 1000);
    // unref so timer doesn't keep process alive (important for tests)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    voteTimers.set(threadId, timer);

    socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_started', {
      threadId,
      votingState,
    });

    reply.status(201);
    return votingState;
  });

  // POST /api/threads/:threadId/vote — cast a vote
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/vote', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request);
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }

    const votingState = await threadStore.getVotingState(threadId);
    if (!votingState || votingState.status !== 'active') {
      reply.status(404);
      return { error: '当前没有活跃投票', code: 'NO_ACTIVE_VOTE' };
    }

    // Check deadline
    if (Date.now() > votingState.deadline) {
      reply.status(410);
      return { error: '投票已超时', code: 'VOTE_EXPIRED' };
    }

    const parseResult = castVoteSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const { option } = parseResult.data;
    if (!votingState.options.includes(option)) {
      reply.status(400);
      return { error: '无效选项', code: 'INVALID_OPTION' };
    }

    // P1-2 fix: enforce voters restriction
    if (
      votingState.voters &&
      votingState.voters.length > 0 &&
      !votingState.voters.includes(userId) &&
      userId !== votingState.initiatedByCat
    ) {
      reply.status(403);
      return { error: '你不在投票人名单中', code: 'NOT_DESIGNATED_VOTER' };
    }

    votingState.votes[userId] = option;
    await threadStore.updateVotingState(threadId, votingState);

    const voteCount = Object.keys(votingState.votes).length;

    if (votingState.anonymous) {
      socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_cast', {
        threadId,
        voteCount,
      });
    } else {
      socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_cast', {
        threadId,
        userId,
        option,
      });
    }

    // Phase 2: Auto-close when all designated voters have voted
    if (checkVoteCompletion(votingState)) {
      const tally = buildVoteTally(votingState.options, votingState.votes);
      const totalVotes = Object.values(votingState.votes).length;
      const fields = votingState.options.map((opt) => ({
        label: opt,
        value: `${tally[opt] ?? 0} 票 (${totalVotes > 0 ? Math.round(((tally[opt] ?? 0) / totalVotes) * 100) : 0}%)`,
      }));

      const closedResult = { ...votingState, status: 'closed' as const };
      const publicResult = votingState.anonymous
        ? { ...closedResult, votes: {} as Record<string, string>, tally }
        : { ...closedResult, tally };

      const richBlock = {
        id: `vote-${Date.now()}`,
        kind: 'card' as const,
        v: 1 as const,
        title: `投票结果: ${votingState.question}`,
        bodyMarkdown: votingState.anonymous ? `匿名投票 · ${totalVotes} 票` : `实名投票 · ${totalVotes} 票`,
        tone: 'info' as const,
        fields,
      };

      await threadStore.updateVotingState(threadId, null);
      clearVoteTimer(threadId);
      socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_closed', {
        threadId,
        result: publicResult,
        richBlock,
      });

      // P1-3 fix: persist rich block on auto-close via cast
      if (messageStore) {
        try {
          const stored = await messageStore.append({
            userId: 'system',
            catId: null,
            content: `投票结果: ${votingState.question}`,
            mentions: [],
            timestamp: Date.now(),
            threadId,
            source: VOTE_RESULT_SOURCE,
            extra: { rich: { v: 1 as const, blocks: [richBlock] } },
          });
          socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
            threadId,
            message: {
              id: stored.id,
              type: 'connector',
              content: stored.content,
              source: VOTE_RESULT_SOURCE,
              timestamp: stored.timestamp,
              extra: stored.extra,
            },
          });
        } catch (err) {
          log.warn({ threadId, err }, 'Failed to persist vote result');
        }
      }

      const baseResult = votingState.anonymous ? { ...votingState, votes: {}, voteCount } : votingState;
      return { ...baseResult, autoClose: true };
    }

    if (votingState.anonymous) {
      return { ...votingState, votes: {}, voteCount };
    }
    return votingState;
  });

  // GET /api/threads/:threadId/vote — get current vote
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/vote', async (request, reply) => {
    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }

    const vote = await threadStore.getVotingState(threadId);
    if (vote?.anonymous) {
      // Strip voter identities, only show counts
      return { vote: { ...vote, votes: {}, voteCount: Object.keys(vote.votes).length } };
    }
    return { vote };
  });

  // DELETE /api/threads/:threadId/vote — close vote
  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/vote', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request);
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }
    if (thread.createdBy !== userId) {
      reply.status(403);
      return { error: '无权操作此对话的投票', code: 'FORBIDDEN' };
    }

    const votingState = await threadStore.getVotingState(threadId);
    if (!votingState || votingState.status !== 'active') {
      reply.status(404);
      return { error: '当前没有活跃投票', code: 'NO_ACTIVE_VOTE' };
    }

    const result = { ...votingState, status: 'closed' as const };
    await threadStore.updateVotingState(threadId, null);
    clearVoteTimer(threadId);

    const tally = buildVoteTally(result.options, result.votes);

    const totalVotes = Object.values(result.votes).length;
    const fields = result.options.map((opt) => ({
      label: opt,
      value: `${tally[opt] ?? 0} 票 (${totalVotes > 0 ? Math.round(((tally[opt] ?? 0) / totalVotes) * 100) : 0}%)`,
    }));

    // Anonymous: strip voter identities from result, add tally for frontend
    const publicResult = result.anonymous
      ? { ...result, votes: {} as Record<string, string>, tally }
      : { ...result, tally };

    const richBlock = {
      id: `vote-${Date.now()}`,
      kind: 'card' as const,
      v: 1 as const,
      title: `投票结果: ${result.question}`,
      bodyMarkdown: result.anonymous ? `匿名投票 · ${totalVotes} 票` : `实名投票 · ${totalVotes} 票`,
      tone: 'info' as const,
      fields,
    };

    socketManager.broadcastToRoom(`thread:${threadId}`, 'vote_closed', {
      threadId,
      result: publicResult,
      richBlock,
    });

    // P1-3 fix: persist rich block on manual close
    if (messageStore) {
      try {
        const stored = await messageStore.append({
          userId: result.createdBy,
          catId: null,
          content: `投票结果: ${result.question}`,
          mentions: [],
          timestamp: Date.now(),
          threadId,
          source: VOTE_RESULT_SOURCE,
          extra: { rich: { v: 1 as const, blocks: [richBlock] } },
        });
        socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
          threadId,
          message: {
            id: stored.id,
            type: 'connector',
            content: stored.content,
            source: VOTE_RESULT_SOURCE,
            timestamp: stored.timestamp,
            extra: stored.extra,
          },
        });
      } catch (err) {
        log.warn({ threadId, err }, 'Failed to persist vote result');
      }
    }

    return { result: publicResult, richBlock };
  });
};
