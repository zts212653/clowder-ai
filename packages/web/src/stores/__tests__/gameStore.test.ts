import type { GameView, SeatView } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from '../gameStore';

const seerSeat: SeatView = {
  seatId: 'P2',
  actorType: 'human',
  actorId: 'user1',
  displayName: '铲屎官',
  role: 'seer',
  alive: true,
};
const wolfSeat: SeatView = {
  seatId: 'P1',
  actorType: 'cat',
  actorId: 'opus',
  displayName: '宪宪',
  role: 'wolf',
  alive: true,
};
const guardSeat: SeatView = {
  seatId: 'P3',
  actorType: 'cat',
  actorId: 'codex',
  displayName: '砚砚',
  role: 'guard',
  alive: true,
};
const witchSeat: SeatView = {
  seatId: 'P4',
  actorType: 'cat',
  actorId: 'gemini',
  displayName: '烁烁',
  role: 'witch',
  alive: true,
};

function makeView(overrides: Partial<GameView> = {}): GameView {
  return {
    gameId: 'g1',
    threadId: 't1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'day_discuss',
    round: 2,
    seats: [],
    visibleEvents: [],
    config: { timeoutMs: 180000, voiceMode: false, humanRole: 'player' },
    ...overrides,
  };
}

describe('gameStore', () => {
  beforeEach(() => useGameStore.getState().clearGame());

  it('setGameView populates state and marks game active', () => {
    const view = makeView();
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.isGameActive).toBe(true);
    expect(s.gameId).toBe('g1');
    expect(s.threadId).toBe('t1');
    expect(s.gameView?.currentPhase).toBe('day_discuss');
    expect(s.isNight).toBe(false);
  });

  it('clearGame resets all state', () => {
    useGameStore.getState().setGameView(makeView(), 'g1', 't1');
    useGameStore.getState().clearGame();
    const s = useGameStore.getState();
    expect(s.isGameActive).toBe(false);
    expect(s.gameView).toBeNull();
    expect(s.gameId).toBeNull();
  });

  it('isNight = true for night_wolf phase', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_wolf' }), 'g1', 't1');
    expect(useGameStore.getState().isNight).toBe(true);
  });

  it('isNight = true for night_seer phase', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_seer' }), 'g1', 't1');
    expect(useGameStore.getState().isNight).toBe(true);
  });

  it('isNight = false for day_discuss phase', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'day_discuss' }), 'g1', 't1');
    expect(useGameStore.getState().isNight).toBe(false);
  });

  it('isNight = true for any phase containing "night"', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_resolve' }), 'g1', 't1');
    expect(useGameStore.getState().isNight).toBe(true);
  });

  it('finished game is still active (for result screen)', () => {
    useGameStore.getState().setGameView(makeView({ status: 'finished' }), 'g1', 't1');
    expect(useGameStore.getState().isGameActive).toBe(true);
  });

  it('lobby game is active', () => {
    useGameStore.getState().setGameView(makeView({ status: 'lobby' }), 'g1', 't1');
    expect(useGameStore.getState().isGameActive).toBe(true);
  });

  it('setSelectedTarget and clear', () => {
    useGameStore.getState().setSelectedTarget('P3');
    expect(useGameStore.getState().selectedTarget).toBe('P3');
    useGameStore.getState().setSelectedTarget(null);
    expect(useGameStore.getState().selectedTarget).toBeNull();
  });

  it('setGodScopeFilter updates filter', () => {
    useGameStore.getState().setGodScopeFilter('wolves');
    expect(useGameStore.getState().godScopeFilter).toBe('wolves');
  });

  // === Derived state: mySeatId, myRole, isGodView ===

  it('derives mySeatId and role from config.humanSeat', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P2', humanRole: 'player' },
      seats: [wolfSeat, seerSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.mySeatId).toBe('P2');
    expect(s.myRole).toBe('seer');
    expect(s.myActionLabel).toBe('查验');
    expect(s.myRoleIcon).toBe('🔮');
    expect(s.isGodView).toBe(false);
  });

  it('isGodView = true when humanRole is god-view', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'god-view' },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().isGodView).toBe(true);
    expect(useGameStore.getState().mySeatId).toBeNull();
  });

  it('mySeatId is null when humanSeat not set', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'player' },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().mySeatId).toBeNull();
    expect(useGameStore.getState().myRole).toBeNull();
  });

  it('clearGame resets derived state', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P1', humanRole: 'player' },
      seats: [{ ...wolfSeat, actorType: 'human', actorId: 'u1', displayName: 'User' }],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().mySeatId).toBe('P1');

    useGameStore.getState().clearGame();
    const s = useGameStore.getState();
    expect(s.mySeatId).toBeNull();
    expect(s.myRole).toBeNull();
    expect(s.isGodView).toBe(false);
    expect(s.myActionLabel).toBeNull();
    expect(s.currentActionName).toBeNull();
    expect(s.hasTargetedAction).toBe(false);
    expect(s.altActionName).toBeNull();
    expect(s.godSeats).toEqual([]);
    expect(s.godNightSteps).toEqual([]);
  });

  // === P1 Round 2: currentActionName ===

  it('derives currentActionName from phase (night_wolf → kill)', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_wolf' }), 'g1', 't1');
    expect(useGameStore.getState().currentActionName).toBe('kill');
  });

  it('derives currentActionName from phase (night_seer → divine)', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_seer' }), 'g1', 't1');
    expect(useGameStore.getState().currentActionName).toBe('divine');
  });

  it('derives currentActionName from phase (day_vote → vote)', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'day_vote' }), 'g1', 't1');
    expect(useGameStore.getState().currentActionName).toBe('vote');
  });

  it('currentActionName is null for unmapped phases', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'day_announce' }), 'g1', 't1');
    expect(useGameStore.getState().currentActionName).toBeNull();
  });

  // === P1 Round 2: myActionHint ===

  it('derives myActionHint for seer at night', () => {
    const view = makeView({
      currentPhase: 'night_seer',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P2', humanRole: 'player' },
      seats: [wolfSeat, seerSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().myActionHint).toBe('选择目标进行查验');
  });

  it('derives myActionHint for day_vote', () => {
    const view = makeView({
      currentPhase: 'day_vote',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P2', humanRole: 'player' },
      seats: [wolfSeat, seerSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().myActionHint).toBe('投票选择放逐目标');
  });

  // === P1 Round 2: godSeats ===

  it('derives godSeats in god-view mode', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'god-view' },
      seats: [wolfSeat, seerSeat, guardSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.godSeats).toHaveLength(3);
    expect(s.godSeats[0]).toEqual({
      seatId: 'P1',
      role: '狼人 wolf',
      faction: undefined,
      alive: true,
      status: 'alive',
    });
    expect(s.godSeats[1]).toEqual({
      seatId: 'P2',
      role: '预言家 seer',
      faction: undefined,
      alive: true,
      status: 'alive',
    });
  });

  it('godSeats is empty in player mode', () => {
    const view = makeView({
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P2', humanRole: 'player' },
      seats: [wolfSeat, seerSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().godSeats).toEqual([]);
  });

  // === P1 Round 2: godNightSteps ===

  it('derives godNightSteps with correct status during night_seer', () => {
    const view = makeView({
      currentPhase: 'night_seer',
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'god-view' },
      seats: [wolfSeat, seerSeat, guardSeat, witchSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const steps = useGameStore.getState().godNightSteps;
    // Order: guard, wolf, seer, witch
    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({ roleName: 'guard', detail: '守护', status: 'done' });
    expect(steps[1]).toEqual({ roleName: 'wolf', detail: '袭击', status: 'done' });
    expect(steps[2]).toEqual({ roleName: 'seer', detail: '查验', status: 'in_progress' });
    expect(steps[3]).toEqual({ roleName: 'witch', detail: '使用药水', status: 'pending' });
  });

  it('godNightSteps is empty during day phase in god-view', () => {
    const view = makeView({
      currentPhase: 'day_discuss',
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'god-view' },
      seats: [wolfSeat, seerSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().godNightSteps).toEqual([]);
  });

  it('godNightSteps is empty in player mode even at night', () => {
    const view = makeView({
      currentPhase: 'night_wolf',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P1', humanRole: 'player' },
      seats: [wolfSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().godNightSteps).toEqual([]);
  });

  // === P1 Round 3: hasTargetedAction ===

  it('hasTargetedAction true for night_wolf (player)', () => {
    const view = makeView({
      currentPhase: 'night_wolf',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P1', humanRole: 'player' },
      seats: [wolfSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().hasTargetedAction).toBe(true);
  });

  it('hasTargetedAction true for day_hunter (player)', () => {
    const hunterSeat: SeatView = {
      seatId: 'P5',
      actorType: 'human',
      actorId: 'user1',
      displayName: '铲屎官',
      role: 'hunter',
      alive: true,
    };
    const view = makeView({
      currentPhase: 'day_hunter',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P5', humanRole: 'player' },
      seats: [hunterSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.hasTargetedAction).toBe(true);
    expect(s.currentActionName).toBe('shoot');
    expect(s.myActionHint).toBe('选择目标开枪');
  });

  it('hasTargetedAction false for villager in night_wolf (role mismatch)', () => {
    const villagerSeat: SeatView = {
      seatId: 'P6',
      actorType: 'human',
      actorId: 'user1',
      displayName: '铲屎官',
      role: 'villager',
      alive: true,
    };
    const view = makeView({
      currentPhase: 'night_wolf',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P6', humanRole: 'player' },
      seats: [villagerSeat, wolfSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().hasTargetedAction).toBe(false);
  });

  it('hasTargetedAction false for day_discuss', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'day_discuss' }), 'g1', 't1');
    expect(useGameStore.getState().hasTargetedAction).toBe(false);
  });

  it('hasTargetedAction false for god-view even at night', () => {
    const view = makeView({
      currentPhase: 'night_wolf',
      config: { timeoutMs: 180000, voiceMode: false, humanRole: 'god-view' },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    expect(useGameStore.getState().hasTargetedAction).toBe(false);
  });

  // === P1 Round 3: witch altActionName (poison) ===

  it('altActionName is poison during night_witch', () => {
    const view = makeView({
      currentPhase: 'night_witch',
      config: { timeoutMs: 180000, voiceMode: false, humanSeat: 'P4', humanRole: 'player' },
      seats: [witchSeat],
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.currentActionName).toBe('heal');
    expect(s.altActionName).toBe('poison');
    expect(s.hasTargetedAction).toBe(true);
    expect(s.myActionHint).toBe('选择救人或毒人');
  });

  it('altActionName is null for non-witch phases', () => {
    useGameStore.getState().setGameView(makeView({ currentPhase: 'night_wolf' }), 'g1', 't1');
    expect(useGameStore.getState().altActionName).toBeNull();
  });

  it('detective mode: isDetective true, godSeats populated, hasTargetedAction false', () => {
    const view = makeView({
      seats: [wolfSeat, seerSeat, guardSeat],
      config: {
        timeoutMs: 180000,
        voiceMode: false,
        humanRole: 'detective',
        detectiveSeatId: 'P1',
      },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.isDetective).toBe(true);
    expect(s.isGodView).toBe(false);
    expect(s.godSeats).toHaveLength(3);
    expect(s.hasTargetedAction).toBe(false);
    expect(s.detectiveBoundName).toBe('宪宪');
  });

  it('detective mode: godNightSteps populated during night', () => {
    const view = makeView({
      seats: [wolfSeat, seerSeat],
      currentPhase: 'night_wolf',
      config: {
        timeoutMs: 180000,
        voiceMode: false,
        humanRole: 'detective',
        detectiveSeatId: 'P1',
      },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.isDetective).toBe(true);
    expect(s.godNightSteps.length).toBeGreaterThan(0);
    expect(s.isNight).toBe(true);
  });

  it('detective mode: detectiveBoundName null when no detectiveSeatId', () => {
    const view = makeView({
      seats: [wolfSeat],
      config: {
        timeoutMs: 180000,
        voiceMode: false,
        humanRole: 'detective',
      },
    });
    useGameStore.getState().setGameView(view, 'g1', 't1');
    const s = useGameStore.getState();
    expect(s.isDetective).toBe(true);
    expect(s.detectiveBoundName).toBeNull();
  });
});
