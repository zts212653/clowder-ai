import type { GameAction, SeatId } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ActionNotifier } from '../domains/cats/services/game/GameNarratorDriver.js';
import type { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

const submitActionSchema = z.object({
  round: z.number().int().min(1),
  phase: z.string().min(1),
  seat: z.number().int().min(1),
  action: z.string().min(1),
  target: z.number().int().min(1).optional(),
  text: z.string().max(2000).optional(),
  nonce: z.string().min(1).max(200),
});

export interface GameActionRoutesOptions {
  gameStore: IGameStore;
  orchestrator: GameOrchestrator;
  threadStore: IThreadStore;
  actionNotifier?: ActionNotifier;
}

const submittedNonces = new Map<string, Set<string>>();

function isNonceDuplicate(gameId: string, nonce: string): boolean {
  const gameNonces = submittedNonces.get(gameId);
  if (!gameNonces) return false;
  return gameNonces.has(nonce);
}

function recordNonce(gameId: string, nonce: string): void {
  let gameNonces = submittedNonces.get(gameId);
  if (!gameNonces) {
    gameNonces = new Set();
    submittedNonces.set(gameId, gameNonces);
  }
  gameNonces.add(nonce);
}

export function clearGameNonces(gameId: string): void {
  submittedNonces.delete(gameId);
}

export const gameActionRoutes: FastifyPluginAsync<GameActionRoutesOptions> = async (app, opts) => {
  const { gameStore, orchestrator, threadStore, actionNotifier } = opts;

  app.post<{
    Params: { gameId: string };
  }>('/api/game/:gameId/action', async (request, reply) => {
    const parseResult = submitActionSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const { gameId } = request.params;
    const { round, phase, seat, action, target, text, nonce } = parseResult.data;

    const callerCatId = request.headers['x-cat-id'] as string | undefined;
    if (!callerCatId) {
      reply.status(401);
      return { error: 'x-cat-id header is required' };
    }

    // P0: Verify caller identity via x-cat-cafe-user header (system-authenticated)
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'x-cat-cafe-user header is required' };
    }

    const runtime = await gameStore.getGame(gameId);
    if (!runtime) {
      reply.status(404);
      return { error: 'Game not found' };
    }

    // P0: Verify the caller owns the thread this game belongs to
    const thread = await threadStore.get(runtime.threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied: you do not own this game thread' };
    }

    if (runtime.status !== 'playing') {
      reply.status(409);
      return { error: `Game is not active (status: ${runtime.status})` };
    }

    if (runtime.round !== round) {
      reply.status(409);
      return { error: `Round mismatch: game is on round ${runtime.round}, you sent ${round}` };
    }

    if (runtime.currentPhase !== phase) {
      reply.status(409);
      return { error: `Phase mismatch: game is on phase ${runtime.currentPhase}, you sent ${phase}` };
    }

    const seatId = `P${seat}` as SeatId;
    const seatObj = runtime.seats.find((s) => s.seatId === seatId);
    if (!seatObj) {
      reply.status(400);
      return { error: `Seat ${seat} does not exist in this game` };
    }

    if (seatObj.actorId !== callerCatId) {
      reply.status(403);
      return { error: `You (${callerCatId}) are not the actor for seat ${seat} (${seatObj.actorId})` };
    }

    if (!seatObj.alive) {
      reply.status(409);
      return { error: `Seat ${seat} is not alive` };
    }

    if (isNonceDuplicate(gameId, nonce)) {
      return { accepted: true, deduplicated: true };
    }

    const gameAction: GameAction = {
      seatId,
      actionName: action,
      targetSeat: target ? (`P${target}` as SeatId) : undefined,
      params: text ? { speechText: text } : undefined,
      submittedAt: Date.now(),
    };

    try {
      await orchestrator.handlePlayerAction(gameId, seatId, gameAction);
      recordNonce(gameId, nonce);
      actionNotifier?.onActionReceived(gameId, seatId);
      return { accepted: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }
  });
};
