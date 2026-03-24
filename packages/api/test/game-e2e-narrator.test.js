import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGameDriver } from '../dist/domains/cats/services/game/createGameDriver.js';
import { GameNarratorDriver, TIME_BUDGETS } from '../dist/domains/cats/services/game/GameNarratorDriver.js';

function make7pRuntime(phaseOverride, extraOverrides = {}) {
  return {
    gameId: 'game-e2e-001',
    threadId: 'thread-e2e-001',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf 7P',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: '狼人', nightActionPhase: 'night_wolf' },
        { name: 'seer', faction: 'village', description: '预言家', nightActionPhase: 'night_seer' },
        { name: 'witch', faction: 'village', description: '女巫', nightActionPhase: 'night_witch' },
        { name: 'hunter', faction: 'village', description: '猎人' },
        { name: 'villager', faction: 'village', description: '村民' },
      ],
      phases: [
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 45000, autoAdvance: true },
        { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 45000, autoAdvance: true },
        { name: 'night_witch', type: 'night_action', actingRole: 'witch', timeoutMs: 45000, autoAdvance: true },
        { name: 'day_discuss', type: 'day_discuss', actingRole: '*', timeoutMs: 30000, autoAdvance: true },
        { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 20000, autoAdvance: true },
      ],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'witch', alive: true, properties: {} },
      { seatId: 'P5', actorType: 'cat', actorId: 'spark', role: 'hunter', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'sonnet', role: 'villager', alive: true, properties: {} },
      { seatId: 'P7', actorType: 'human', actorId: 'you', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: phaseOverride ?? 'night_wolf',
    round: 1,
    eventLog: [],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 45000, voiceMode: false, humanRole: 'player', humanSeat: 'P7' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extraOverrides,
  };
}

describe('E2E: 7-person game lifecycle via GameNarratorDriver [AC-I10]', () => {
  it('full night→discuss→vote cycle with all phases dispatched', async () => {
    const phases = ['night_wolf', 'night_seer', 'night_witch', 'day_discuss', 'day_vote'];
    let phaseIndex = 0;
    let currentRuntime = make7pRuntime(phases[0]);
    let discussWakeCount = 0;

    const wakes = [];
    const waitActions = [];
    const waitAllActions = [];

    const gameStore = {
      getGame: async () => {
        if (phaseIndex >= phases.length) return { ...currentRuntime, status: 'ended' };
        return currentRuntime;
      },
      listActiveGames: async () => [],
      createGame: async (r) => r,
      getActiveGame: async () => null,
      updateGame: async (_id, rt) => {
        currentRuntime = rt;
      },
      endGame: async () => {},
    };

    function advancePhase() {
      phaseIndex++;
      if (phaseIndex < phases.length) {
        currentRuntime = make7pRuntime(phases[phaseIndex], {
          eventLog: [...currentRuntime.eventLog],
          version: currentRuntime.version,
        });
      }
    }

    const orchestrator = { async broadcastGameState() {} };

    const wakeCat = async (params) => {
      wakes.push(params);
    };

    const actionNotifier = {
      waitForAction: async (gameId, seatId, timeout) => {
        waitActions.push({ gameId, seatId, timeout });
        discussWakeCount++;
        if (discussWakeCount >= 7) {
          advancePhase();
          discussWakeCount = 0;
        }
        return true;
      },
      waitForAllActions: async (gameId, seatIds, timeout) => {
        waitAllActions.push({ gameId, seatIds, timeout });
        advancePhase();
      },
      onActionReceived: () => {},
      cleanup: () => {},
    };

    const driver = new GameNarratorDriver({ gameStore, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-e2e-001');
    await new Promise((r) => setTimeout(r, 1500));
    driver.stopLoop('game-e2e-001');
    await new Promise((r) => setTimeout(r, 200));

    const narrativeTexts = currentRuntime.eventLog.filter((e) => e.type === 'narrative').map((e) => e.payload.text);

    assert.ok(
      narrativeTexts.some((t) => t.includes('狼人请睁眼')),
      'wolf open',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('狼人请闭眼')),
      'wolf close',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('预言家请睁眼')),
      'seer open',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('预言家请闭眼')),
      'seer close',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('女巫请睁眼')),
      'witch open',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('女巫请闭眼')),
      'witch close',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('天亮了')),
      'day dawn',
    );
    assert.ok(
      narrativeTexts.some((t) => t.includes('投票')),
      'vote',
    );

    for (const event of currentRuntime.eventLog.filter((e) => e.type === 'narrative')) {
      assert.equal(event.scope, 'public');
      assert.ok(event.eventId);
    }

    const wolfWakes = wakes.filter(
      (w) => (w.catId === 'opus' || w.catId === 'codex') && w.timeoutMs === TIME_BUDGETS.nightPerRole,
    );
    assert.ok(wolfWakes.length >= 2, `wolves woken: ${wolfWakes.length}`);

    assert.ok(
      wakes.some((w) => w.catId === 'gemini' && w.timeoutMs === TIME_BUDGETS.nightPerRole),
      'seer woken',
    );
    assert.ok(
      wakes.some((w) => w.catId === 'gpt52' && w.timeoutMs === TIME_BUDGETS.nightPerRole),
      'witch woken',
    );

    const discussWakes = wakes.filter((w) => w.timeoutMs === TIME_BUDGETS.discussPerSpeaker);
    assert.equal(discussWakes.length, 7, '7 speakers in discuss');

    const voteWakes = wakes.filter((w) => w.timeoutMs === TIME_BUDGETS.votePerVoter);
    assert.equal(voteWakes.length, 7, '7 voters');

    assert.ok(waitActions.length >= 7, 'sequential discuss waits');
    assert.ok(
      waitAllActions.some((w) => w.timeout === TIME_BUDGETS.votePerVoter),
      'parallel vote wait',
    );

    const wolfBriefing = wakes.find((w) => w.catId === 'opus');
    assert.ok(wolfBriefing.briefing.includes('狼人'), 'wolf briefing mentions role');
  });

  it('factory creates narrator driver when flag enabled', () => {
    const driver = createGameDriver({
      gameNarratorEnabled: true,
      legacyDeps: { gameStore: {}, orchestrator: {}, messageStore: {} },
      narratorDeps: {
        gameStore: { getGame: async () => null, listActiveGames: async () => [] },
        orchestrator: { broadcastGameState: async () => {} },
        wakeCat: async () => {},
        actionNotifier: {
          waitForAction: async () => true,
          waitForAllActions: async () => {},
          onActionReceived: () => {},
          cleanup: () => {},
        },
      },
    });
    assert.ok(driver instanceof GameNarratorDriver);
    assert.equal(typeof driver.startLoop, 'function');
    assert.equal(typeof driver.recoverActiveGames, 'function');
  });

  it('exits gracefully when game status is not playing', async () => {
    const wakes = [];
    const driver = new GameNarratorDriver({
      gameStore: {
        getGame: async () => ({ ...make7pRuntime(), status: 'ended' }),
        listActiveGames: async () => [],
      },
      orchestrator: { broadcastGameState: async () => {} },
      wakeCat: async (params) => {
        wakes.push(params);
      },
      actionNotifier: {
        waitForAction: async () => true,
        waitForAllActions: async () => {},
        onActionReceived: () => {},
        cleanup: () => {},
      },
    });

    driver.startLoop('game-e2e-001');
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(wakes.length, 0, 'no cats woken for ended game');
  });

  it('wolf briefing does not leak seer/witch identity (info isolation)', async () => {
    const wakes = [];
    const rt = make7pRuntime('night_wolf');

    const driver = new GameNarratorDriver({
      gameStore: {
        getGame: async () => rt,
        listActiveGames: async () => [],
        updateGame: async () => {},
      },
      orchestrator: { broadcastGameState: async () => {} },
      wakeCat: async (params) => {
        wakes.push(params);
      },
      actionNotifier: {
        waitForAction: async () => true,
        waitForAllActions: async () => {},
        onActionReceived: () => {},
        cleanup: () => {},
      },
    });

    driver.startLoop('game-e2e-001');
    await new Promise((r) => setTimeout(r, 300));
    driver.stopLoop('game-e2e-001');
    await new Promise((r) => setTimeout(r, 100));

    for (const wake of wakes) {
      assert.ok(!wake.briefing.includes('预言家'), 'wolf briefing should not leak seer');
      assert.ok(!wake.briefing.includes('女巫'), 'wolf briefing should not leak witch');
    }
  });
});
