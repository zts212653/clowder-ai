/**
 * Game API Routes (F101)
 *
 * CRUD for game lifecycle within a thread.
 * Includes high-level POST /api/game/start for frontend-driven game creation.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getAllCatIdsFromConfig } from '../config/cat-config-loader.js';
import { createGameDriver } from '../domains/cats/services/game/createGameDriver.js';
import type { GameDriver } from '../domains/cats/services/game/GameDriver.js';
import { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import { GameViewBuilder } from '../domains/cats/services/game/GameViewBuilder.js';
import { WerewolfLobby } from '../domains/cats/services/game/werewolf/WerewolfLobby.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';
import { clearGameNonces } from './game-actions.js';
import { buildGameSeats, sanitizeCatIds } from './game-command-interceptor.js';

interface SocketLike {
  broadcastToRoom(room: string, event: string, data: unknown): void;
  emitToUser(userId: string, event: string, data: unknown): void;
}

export interface GameRoutesOptions {
  gameStore: IGameStore;
  socketManager: SocketLike;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  autoPlayer?: Pick<GameDriver, 'startLoop' | 'stopAllLoops'>;
}

const seatSchema = z.object({
  seatId: z.string().regex(/^P\d+$/),
  actorType: z.enum(['human', 'cat', 'system']),
  actorId: z.string().min(1),
  role: z.string().min(1),
  alive: z.boolean(),
  properties: z.record(z.unknown()).default({}),
});

const roleSchema = z.object({
  name: z.string().min(1),
  faction: z.string().min(1),
  description: z.string(),
  nightActionPhase: z.string().optional(),
});

const phaseSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['night_action', 'day_discuss', 'day_vote', 'resolve', 'announce']),
  actingRole: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  autoAdvance: z.boolean(),
});

const actionDefSchema = z.object({
  name: z.string().min(1),
  allowedRole: z.string().min(1),
  allowedPhase: z.string().min(1),
  targetRequired: z.boolean(),
  schema: z.record(z.unknown()).default({}),
});

const definitionSchema = z.object({
  gameType: z.string().min(1),
  displayName: z.string().min(1),
  minPlayers: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  roles: z.array(roleSchema),
  phases: z.array(phaseSchema).min(1),
  actions: z.array(actionDefSchema),
  winConditions: z.array(
    z.object({
      faction: z.string(),
      description: z.string(),
      check: z.string(),
    }),
  ),
});

const startGameSchema = z.object({
  definition: definitionSchema,
  seats: z.array(seatSchema).min(1),
  config: z
    .object({
      timeoutMs: z.number().int().positive(),
      voiceMode: z.boolean(),
      humanRole: z.enum(['player', 'god-view']),
      humanSeat: z
        .string()
        .regex(/^P\d+$/)
        .optional(),
    })
    .refine((c) => c.humanRole !== 'player' || c.humanSeat, {
      message: 'humanSeat is required when humanRole is player',
    }),
});

const actionSchema = z.object({
  seatId: z.string().regex(/^P\d+$/),
  actionName: z.string().min(1),
  targetSeat: z
    .string()
    .regex(/^P\d+$/)
    .optional(),
  params: z.record(z.unknown()).optional(),
});

/** Valid board preset player counts */
const VALID_PLAYER_COUNTS = [6, 7, 8, 9, 10, 12] as const;
const DEFAULT_PLAYER_COUNT = 7;

const gameStartSchema = z.object({
  gameType: z.enum(['werewolf']),
  humanRole: z.enum(['player', 'god-view', 'detective']),
  playerCount: z.number().int().min(6).max(12).default(DEFAULT_PLAYER_COUNT),
  catIds: z.array(z.string().min(1)).min(1),
  voiceMode: z.boolean().default(false),
  detectiveCatId: z.string().min(1).optional(),
});

export const gameRoutes: FastifyPluginAsync<GameRoutesOptions> = async (app, opts) => {
  const { gameStore, socketManager, threadStore, messageStore } = opts;
  const orchestrator = new GameOrchestrator({ gameStore, socketManager, messageStore });
  const autoPlayer =
    opts.autoPlayer ??
    createGameDriver({
      gameNarratorEnabled: false,
      legacyDeps: { gameStore, orchestrator, messageStore },
    });

  app.addHook('onClose', async () => {
    autoPlayer.stopAllLoops();
  });

  // POST /api/game/start — High-level game creation (frontend-driven)
  // Accepts structured payload, creates game thread, builds seats, starts game,
  // returns { gameId, gameThreadId } for immediate navigation.
  app.post('/api/game/start', async (request, reply) => {
    const parseResult = gameStartSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const { gameType, humanRole, playerCount, catIds: rawCatIds, voiceMode, detectiveCatId } = parseResult.data;

    // Detective mode requires detectiveCatId
    if (humanRole === 'detective' && !detectiveCatId) {
      reply.status(400);
      return { error: 'detectiveCatId is required for detective mode' };
    }

    // Sanitize catIds against known config
    const allCatIds = getAllCatIdsFromConfig();
    const sanitized = sanitizeCatIds(rawCatIds, allCatIds);
    const catIds = sanitized.length > 0 ? sanitized : [...allCatIds];

    // Clamp to valid preset
    const clampedCount = VALID_PLAYER_COUNTS.reduce((best, preset) => (preset <= playerCount ? preset : best));

    // Resolve user identity (matches messages.ts behavior)
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Could not determine user identity' };
    }
    const seats = buildGameSeats({ humanRole, userId, catIds, playerCount: clampedCount });

    // Validate detectiveCatId maps to an actual seat BEFORE creating any persistent resources
    let resolvedDetectiveSeatId: import('@cat-cafe/shared').SeatId | undefined;
    if (humanRole === 'detective' && detectiveCatId) {
      const seat = seats.find((s) => s.actorId === detectiveCatId);
      if (!seat) {
        reply.status(400);
        return { error: 'detectiveCatId does not match any seat in this game' };
      }
      resolvedDetectiveSeatId = seat.seatId;
    }

    // Create independent game thread with play mode (Layer 1 info isolation, KD-40/AC-I9)
    const gameTitle = `狼人杀 — ${clampedCount}人局`;
    const gameThread = await threadStore.create(userId, gameTitle, `games/${gameType}`);
    const gameThreadId = gameThread.id;
    await threadStore.updateThinkingMode(gameThreadId, 'play');

    // Store a system message in the game thread for context
    await messageStore.append({
      userId,
      catId: null,
      content: `🎮 ${gameTitle} 开始`,
      mentions: [],
      timestamp: Date.now(),
      threadId: gameThreadId,
    });

    // WerewolfLobby for role assignment, then orchestrator for persistence + broadcast
    const lobby = new WerewolfLobby();
    const lobbyRuntime = lobby.createLobby({
      threadId: gameThreadId,
      playerCount: clampedCount,
      players: seats.map((s) => ({ actorType: s.actorType, actorId: s.actorId })),
    });
    lobby.startGame(lobbyRuntime);

    let gameRuntime;
    try {
      gameRuntime = await orchestrator.startGame({
        threadId: gameThreadId,
        definition: lobbyRuntime.definition,
        seats: lobbyRuntime.seats,
        config: {
          timeoutMs: 30000,
          voiceMode,
          humanRole,
          ...(humanRole === 'player' ? { humanSeat: 'P1' as const } : {}),
          ...(resolvedDetectiveSeatId ? { detectiveSeatId: resolvedDetectiveSeatId } : {}),
          observerUserId: userId, // H2 fix: always set — messageStore dual-write needs userId for thread visibility
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already has an active game')) {
        reply.status(409);
        return { error: message };
      }
      reply.status(500);
      return { error: message };
    }

    // Broadcast scoped views so frontend receives game:state_update
    await orchestrator.broadcastGameState(gameRuntime.gameId);

    // Start AI auto-play loop
    autoPlayer.startLoop(gameRuntime.gameId);

    return {
      status: 'game_started',
      gameId: gameRuntime.gameId,
      gameThreadId,
    };
  });

  // POST /api/threads/:threadId/game — Start a game (low-level, pre-built definition)
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/game', async (request, reply) => {
    const parseResult = startGameSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    const { threadId } = request.params;
    const { definition, seats, config } = parseResult.data;

    try {
      const runtime = await orchestrator.startGame({
        threadId,
        definition: definition as Parameters<typeof orchestrator.startGame>[0]['definition'],
        seats: seats as Parameters<typeof orchestrator.startGame>[0]['seats'],
        config: config as Parameters<typeof orchestrator.startGame>[0]['config'],
      });

      // Set play mode on existing thread (Layer 1 info isolation, KD-40/AC-I9)
      await threadStore.updateThinkingMode(threadId, 'play');

      return runtime;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already has an active game')) {
        reply.status(409);
        return { error: message };
      }
      reply.status(500);
      return { error: message };
    }
  });

  // GET /api/threads/:threadId/game?viewer=P2 — Get scoped game view
  app.get<{ Params: { threadId: string }; Querystring: { viewer?: string } }>(
    '/api/threads/:threadId/game',
    async (request, reply) => {
      const { threadId } = request.params;
      const runtime = await gameStore.getActiveGame(threadId);
      if (!runtime) {
        reply.status(404);
        return { error: 'No active game in this thread' };
      }

      const requestedViewer = (request.query as { viewer?: string }).viewer;

      // Determine effective viewer based on humanRole
      let viewer: string;
      if (runtime.config.humanRole === 'god-view') {
        // God-view mode: allow god or any seat
        viewer = requestedViewer ?? 'god';
      } else if (runtime.config.humanRole === 'detective') {
        // Detective mode: locked to detective:{boundSeatId}
        const boundSeat = runtime.config.detectiveSeatId;
        if (!boundSeat) {
          reply.status(400);
          return { error: 'detective mode requires detectiveSeatId in game config' };
        }
        viewer = `detective:${boundSeat}`;
      } else {
        // Player mode: lock to humanSeat, reject god/other-seat requests
        const humanSeat = runtime.config.humanSeat;
        if (!humanSeat) {
          reply.status(400);
          return { error: 'player mode requires humanSeat in game config' };
        }
        if (requestedViewer && requestedViewer !== humanSeat) {
          reply.status(403);
          return { error: `viewer must be your own seat (${humanSeat})` };
        }
        viewer = humanSeat;
      }

      const view = GameViewBuilder.buildView(
        runtime,
        viewer as import('@cat-cafe/shared').SeatId | 'god' | `detective:${string}`,
      );
      return view;
    },
  );

  // POST /api/threads/:threadId/game/action — Submit player action
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/game/action', async (request, reply) => {
    const parseResult = actionSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid action', details: parseResult.error.issues };
    }

    const { threadId } = request.params;
    const runtime = await gameStore.getActiveGame(threadId);
    if (!runtime) {
      reply.status(404);
      return { error: 'No active game in this thread' };
    }

    // God-view and detective cannot submit actions
    if (runtime.config.humanRole === 'god-view' || runtime.config.humanRole === 'detective') {
      reply.status(403);
      return { error: `${runtime.config.humanRole} mode: actions are not allowed` };
    }

    const { seatId, actionName, targetSeat, params } = parseResult.data;

    // Bind seatId to humanSeat — prevent impersonating other seats
    if (runtime.config.humanSeat && seatId !== runtime.config.humanSeat) {
      reply.status(403);
      return { error: `seat mismatch: you are assigned to ${runtime.config.humanSeat}, not ${seatId}` };
    }

    try {
      const action: import('@cat-cafe/shared').GameAction = {
        seatId: seatId as `P${number}`,
        actionName,
        submittedAt: Date.now(),
      };
      if (targetSeat) action.targetSeat = targetSeat as `P${number}`;
      if (params) action.params = params;
      await orchestrator.handlePlayerAction(runtime.gameId, seatId, action);
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }
  });

  // POST /api/threads/:threadId/game/god-action — God actions (pause/resume/skip)
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/game/god-action', async (request, reply) => {
    const { threadId } = request.params;
    const runtime = await gameStore.getActiveGame(threadId);
    if (!runtime) {
      reply.status(404);
      return { error: 'No active game in this thread' };
    }

    if (runtime.config.humanRole !== 'god-view') {
      reply.status(403);
      return { error: 'God actions require god-view mode' };
    }

    const body = request.body as { action?: string };
    if (!body?.action) {
      reply.status(400);
      return { error: 'Missing action field' };
    }

    try {
      switch (body.action) {
        case 'pause':
          await orchestrator.pauseGame(runtime.gameId);
          return { ok: true, action: 'pause' };
        case 'resume':
          await orchestrator.resumeGame(runtime.gameId);
          return { ok: true, action: 'resume' };
        case 'skip_phase':
          await orchestrator.skipPhase(runtime.gameId);
          return { ok: true, action: 'skip_phase' };
        default:
          reply.status(400);
          return { error: `Unknown god action: ${body.action}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }
  });

  // DELETE /api/threads/:threadId/game — Abort game
  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/game', async (request, reply) => {
    const { threadId } = request.params;
    const runtime = await gameStore.getActiveGame(threadId);
    if (!runtime) {
      reply.status(404);
      return { error: 'No active game in this thread' };
    }

    await gameStore.endGame(runtime.gameId, 'aborted');
    clearGameNonces(runtime.gameId);

    socketManager.broadcastToRoom(`thread:${threadId}`, 'game:aborted', {
      gameId: runtime.gameId,
      timestamp: Date.now(),
    });

    return { ok: true, gameId: runtime.gameId };
  });
};
