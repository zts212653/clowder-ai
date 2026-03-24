import type { CatId, GameRuntime, SeatId } from '@cat-cafe/shared';
import type { IGameStore } from '../stores/ports/GameStore.js';
import { buildFirstWakeBriefing, buildResumeCapsule } from './briefing.js';
import type { GameDriver } from './GameDriver.js';
import { GameEngine } from './GameEngine.js';

export const TIME_BUDGETS = {
  nightPerRole: 45_000,
  discussPerSpeaker: 30_000,
  votePerVoter: 20_000,
  lastWords: 30_000,
  globalCap: 30 * 60_000,
} as const;

const NIGHT_NARRATIVES: Record<string, string> = {
  wolf: '🐺 狼人请睁眼',
  seer: '🔮 预言家请睁眼',
  guard: '🛡️ 守卫请睁眼',
  witch: '🧪 女巫请睁眼',
};

export type WakeCatFn = (params: {
  threadId: string;
  catId: CatId;
  briefing: string;
  timeoutMs: number;
}) => Promise<void>;

export interface ActionNotifier {
  waitForAction(gameId: string, seatId: SeatId, timeoutMs: number): Promise<boolean>;
  waitForAllActions(gameId: string, seatIds: SeatId[], timeoutMs: number): Promise<void>;
  onActionReceived(gameId: string, seatId: SeatId): void;
  cleanup(gameId: string): void;
}

/** Subset of GameOrchestrator used by narrator driver for state broadcast */
export interface GameStateBroadcaster {
  broadcastGameState(gameId: string): Promise<void>;
}

export interface NarratorDeps {
  gameStore: IGameStore;
  wakeCat: WakeCatFn;
  actionNotifier: ActionNotifier;
  orchestrator: GameStateBroadcaster;
}

export class GameNarratorDriver implements GameDriver {
  private activeLoops = new Map<string, AbortController>();

  constructor(private deps: NarratorDeps) {}

  startLoop(gameId: string): void {
    const ac = new AbortController();
    this.activeLoops.set(gameId, ac);
    this.runGameLoop(gameId, ac.signal)
      .catch(() => {})
      .finally(() => {
        this.activeLoops.delete(gameId);
        this.deps.actionNotifier.cleanup(gameId);
      });
  }

  stopLoop(gameId: string): void {
    const ac = this.activeLoops.get(gameId);
    if (ac) ac.abort();
  }

  stopAllLoops(): void {
    for (const ac of this.activeLoops.values()) ac.abort();
    this.activeLoops.clear();
  }

  async recoverActiveGames(): Promise<number> {
    const games = await this.deps.gameStore.listActiveGames();
    for (const g of games) {
      this.startLoop(g.gameId);
    }
    return games.length;
  }

  private async runGameLoop(gameId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const runtime = await this.deps.gameStore.getGame(gameId);
      if (!runtime || runtime.status !== 'playing') break;

      if (this.isGlobalTimeout(runtime)) {
        await this.postNarrative(gameId, runtime, '⏰ 游戏时间超过 30 分钟，强制结束。');
        break;
      }

      const phaseDef = runtime.definition.phases.find((p: { name: string }) => p.name === runtime.currentPhase);
      if (!phaseDef) break;

      if (phaseDef.type === 'night_action') {
        await this.runNightRole(runtime, signal);
      } else if (phaseDef.type === 'day_discuss') {
        await this.runDayDiscuss(runtime, signal);
      } else if (phaseDef.type === 'day_vote') {
        await this.runDayVote(runtime, signal);
      } else {
        await sleep(500);
      }

      if (signal.aborted) break;
      await sleep(200);
    }
  }

  private async runNightRole(runtime: GameRuntime, signal: AbortSignal): Promise<void> {
    const phaseDef = runtime.definition.phases.find((p: { name: string }) => p.name === runtime.currentPhase);
    const actingRole = phaseDef?.actingRole;
    if (!actingRole) return;

    const seats = runtime.seats.filter((s) => s.alive && s.role === actingRole);
    if (seats.length === 0) return;

    const narrative = NIGHT_NARRATIVES[actingRole] ?? `${actingRole} 请行动`;
    await this.postNarrative(runtime.gameId, runtime, narrative);

    const teammates = actingRole === 'wolf' ? seats.map((s) => ({ catId: s.actorId, seatId: s.seatId })) : undefined;

    for (const seat of seats) {
      if (signal.aborted) return;
      const briefing = this.isFirstWake(runtime)
        ? buildFirstWakeBriefing({
            gameRuntime: runtime,
            seatId: seat.seatId,
            teammates: teammates?.filter((t) => t.seatId !== seat.seatId),
          })
        : buildResumeCapsule({ gameRuntime: runtime, seatId: seat.seatId });

      await this.deps.wakeCat({
        threadId: runtime.threadId,
        catId: seat.actorId as CatId,
        briefing,
        timeoutMs: TIME_BUDGETS.nightPerRole,
      });
    }

    const seatIds = seats.map((s) => s.seatId);
    await this.deps.actionNotifier.waitForAllActions(runtime.gameId, seatIds, TIME_BUDGETS.nightPerRole);

    const closeNarrative = narrative.replace('请睁眼', '请闭眼');
    await this.postNarrative(runtime.gameId, runtime, closeNarrative);
  }

  private async runDayDiscuss(runtime: GameRuntime, signal: AbortSignal): Promise<void> {
    const aliveSeats = runtime.seats.filter((s) => s.alive).sort((a, b) => seatNum(a.seatId) - seatNum(b.seatId));

    await this.postNarrative(runtime.gameId, runtime, '☀️ 天亮了！请各位发表看法。');

    for (const seat of aliveSeats) {
      if (signal.aborted) return;

      await this.postNarrative(runtime.gameId, runtime, `请 座位${seat.seatId.slice(1)} 发言`);

      const briefing = buildResumeCapsule({ gameRuntime: runtime, seatId: seat.seatId });
      await this.deps.wakeCat({
        threadId: runtime.threadId,
        catId: seat.actorId as CatId,
        briefing,
        timeoutMs: TIME_BUDGETS.discussPerSpeaker,
      });

      await this.deps.actionNotifier.waitForAction(runtime.gameId, seat.seatId, TIME_BUDGETS.discussPerSpeaker);
    }
  }

  private async runDayVote(runtime: GameRuntime, signal: AbortSignal): Promise<void> {
    const aliveSeats = runtime.seats.filter((s) => s.alive);

    await this.postNarrative(runtime.gameId, runtime, '🗳️ 投票环节开始！');

    for (const seat of aliveSeats) {
      if (signal.aborted) return;
      const briefing = buildResumeCapsule({ gameRuntime: runtime, seatId: seat.seatId });
      await this.deps.wakeCat({
        threadId: runtime.threadId,
        catId: seat.actorId as CatId,
        briefing,
        timeoutMs: TIME_BUDGETS.votePerVoter,
      });
    }

    const seatIds = aliveSeats.map((s) => s.seatId);
    await this.deps.actionNotifier.waitForAllActions(runtime.gameId, seatIds, TIME_BUDGETS.votePerVoter);
  }

  private async postNarrative(gameId: string, _runtime: GameRuntime, content: string): Promise<void> {
    const fresh = await this.deps.gameStore.getGame(gameId);
    if (!fresh || fresh.status !== 'playing') return;

    const engine = new GameEngine(fresh);
    engine.appendEvent({
      round: fresh.round,
      phase: fresh.currentPhase,
      type: 'narrative',
      scope: 'public',
      payload: { text: content },
    });

    await this.deps.gameStore.updateGame(gameId, engine.getRuntime());
    await this.deps.orchestrator.broadcastGameState(gameId);
  }

  private isFirstWake(runtime: GameRuntime): boolean {
    return runtime.round === 1 && runtime.currentPhase.startsWith('night_');
  }

  private isGlobalTimeout(runtime: GameRuntime): boolean {
    return Date.now() - runtime.createdAt > TIME_BUDGETS.globalCap;
  }
}

function seatNum(seatId: SeatId): number {
  return parseInt(seatId.slice(1), 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
