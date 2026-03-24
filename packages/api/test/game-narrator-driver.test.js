import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameNarratorDriver, TIME_BUDGETS } from '../dist/domains/cats/services/game/GameNarratorDriver.js';

// ---------------------------------------------------------------------------
// Helpers: build a minimal GameRuntime stub matching the shared types
// ---------------------------------------------------------------------------

function makeRuntime(overrides = {}) {
  return {
    gameId: 'game-001',
    threadId: 'thread-001',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: '狼人', nightActionPhase: 'night_wolf' },
        { name: 'seer', faction: 'village', description: '预言家', nightActionPhase: 'night_seer' },
        { name: 'witch', faction: 'village', description: '女巫', nightActionPhase: 'night_witch' },
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
      { seatId: 'P5', actorType: 'cat', actorId: 'spark', role: 'villager', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'sonnet', role: 'villager', alive: true, properties: {} },
      { seatId: 'P7', actorType: 'human', actorId: 'you', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'night_wolf',
    round: 1,
    eventLog: [],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 45000, voiceMode: false, humanRole: 'player', humanSeat: 'P7' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub factories for NarratorDeps
// ---------------------------------------------------------------------------

/** Creates a stub gameStore. getGame returns `runtime` for the first N calls, then returns ended.
 *  Note: postNarrative also calls getGame (fresh-read), so each narrative adds 1 to the count. */
function makeGameStore(runtime, { stopAfterCalls = 50 } = {}) {
  let callCount = 0;
  const updates = [];
  return {
    updates,
    getGame: async () => {
      callCount++;
      if (callCount > stopAfterCalls) return { ...runtime, status: 'ended' };
      return runtime;
    },
    listActiveGames: async () => [runtime],
    createGame: async (r) => r,
    getActiveGame: async () => runtime,
    updateGame: async (_id, rt) => {
      updates.push(rt);
    },
    endGame: async () => {},
  };
}

function makeOrchestrator() {
  const calls = [];
  return {
    calls,
    async broadcastGameState(gameId) {
      calls.push(gameId);
    },
  };
}

function makeWakeCat() {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
  };
  fn.calls = calls;
  return fn;
}

function makeActionNotifier() {
  return {
    calls: { waitForAction: [], waitForAllActions: [], cleanup: [] },
    waitForAction: async function (gameId, seatId, timeout) {
      this.calls.waitForAction.push({ gameId, seatId, timeout });
      return true;
    },
    waitForAllActions: async function (gameId, seatIds, timeout) {
      this.calls.waitForAllActions.push({ gameId, seatIds, timeout });
    },
    onActionReceived: () => {},
    cleanup: function (gameId) {
      this.calls.cleanup.push(gameId);
    },
  };
}

/** Extract narrative text from runtime.eventLog */
function getNarrativeTexts(runtime) {
  return runtime.eventLog.filter((e) => e.type === 'narrative').map((e) => e.payload.text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GameNarratorDriver', () => {
  let runtime;
  let gameStore;
  let orchestrator;
  let wakeCat;
  let actionNotifier;

  beforeEach(() => {
    runtime = makeRuntime();
    gameStore = makeGameStore(runtime, { stopAfterCalls: 4 });
    orchestrator = makeOrchestrator();
    wakeCat = makeWakeCat();
    actionNotifier = makeActionNotifier();
  });

  // --- Night phase ---

  it('night phase: posts narrative, wakes wolf cats, waits for actions, posts close narrative', async () => {
    const driver = new GameNarratorDriver({ gameStore, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');

    // Let the async loop run one iteration (night_wolf) then stop
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    // Should have posted narrative "狼人请睁眼" and then "狼人请闭眼" to eventLog
    const narratives = getNarrativeTexts(runtime);
    assert.ok(
      narratives.some((n) => n.includes('狼人请睁眼')),
      'should post wolf open narrative',
    );
    assert.ok(
      narratives.some((n) => n.includes('狼人请闭眼')),
      'should post wolf close narrative',
    );

    // Should have woken the two wolf cats (P1=opus, P2=codex)
    const wokeIds = wakeCat.calls.map((c) => c.catId);
    assert.ok(wokeIds.includes('opus'), 'should wake opus (wolf)');
    assert.ok(wokeIds.includes('codex'), 'should wake codex (wolf)');
    assert.equal(wakeCat.calls.length, 2, 'should wake exactly 2 wolves');

    // Should have called waitForAllActions with wolf seatIds
    assert.equal(actionNotifier.calls.waitForAllActions.length, 1);
    const waitCall = actionNotifier.calls.waitForAllActions[0];
    assert.deepEqual(waitCall.seatIds.sort(), ['P1', 'P2']);
    assert.equal(waitCall.timeout, TIME_BUDGETS.nightPerRole);
  });

  it('night phase: sends first-wake briefing on round 1', async () => {
    const driver = new GameNarratorDriver({ gameStore, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    // On round 1 + night phase, should use buildFirstWakeBriefing → contains role info
    for (const call of wakeCat.calls) {
      assert.ok(call.briefing.length > 0, `briefing for ${call.catId} should not be empty`);
      assert.ok(call.briefing.includes('狼人'), `briefing for ${call.catId} should mention role`);
    }
  });

  it('night phase: sends resume briefing on round > 1', async () => {
    const rt = makeRuntime({ round: 2, currentPhase: 'night_wolf' });
    const gs = makeGameStore(rt, { stopAfterCalls: 4 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    for (const call of wakeCat.calls) {
      assert.ok(call.briefing.length > 0, `resume briefing for ${call.catId} should not be empty`);
    }
  });

  it('night phase: skips roles with no alive seats', async () => {
    // Kill all wolves → wolf phase should have no wakeCat calls
    const rt = makeRuntime({
      currentPhase: 'night_wolf',
      seats: makeRuntime().seats.map((s) => (s.role === 'wolf' ? { ...s, alive: false } : s)),
    });
    const gs = makeGameStore(rt, { stopAfterCalls: 1 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(wakeCat.calls.length, 0, 'should not wake any cats when all wolves are dead');
  });

  // --- Day discuss phase ---

  it('discuss phase: wakes alive seats sequentially in seat order (AC-I6)', async () => {
    const rt = makeRuntime({ currentPhase: 'day_discuss' });
    // loop-top(1) + dawn narrative getGame(1) + 7 per-seat narrative getGames(7) = 9
    const gs = makeGameStore(rt, { stopAfterCalls: 9 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 300));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    // Should post "天亮了" narrative to eventLog
    const narratives = getNarrativeTexts(rt);
    assert.ok(
      narratives.some((n) => n.includes('天亮了')),
      'should post day dawn narrative',
    );

    // All 7 alive seats should be woken in seat order
    assert.equal(wakeCat.calls.length, 7, 'should wake all 7 alive players');
    const wakeOrder = wakeCat.calls.map((c) => c.catId);
    assert.deepEqual(wakeOrder, ['opus', 'codex', 'gemini', 'gpt52', 'spark', 'sonnet', 'you']);

    // Should call waitForAction for each seat (sequential discuss)
    assert.equal(actionNotifier.calls.waitForAction.length, 7, 'should wait for each speaker sequentially');
    assert.equal(actionNotifier.calls.waitForAction[0].seatId, 'P1');
    assert.equal(actionNotifier.calls.waitForAction[6].seatId, 'P7');
    assert.equal(actionNotifier.calls.waitForAction[0].timeout, TIME_BUDGETS.discussPerSpeaker);
  });

  it('discuss phase: posts per-seat narrative prompts', async () => {
    const rt = makeRuntime({ currentPhase: 'day_discuss' });
    const gs = makeGameStore(rt, { stopAfterCalls: 9 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 300));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    const narratives = getNarrativeTexts(rt);
    assert.ok(
      narratives.some((n) => n.includes('座位1')),
      'should prompt seat 1',
    );
    assert.ok(
      narratives.some((n) => n.includes('座位7')),
      'should prompt seat 7',
    );
  });

  // --- Day vote phase ---

  it('vote phase: wakes all voters and waits for all actions (parallel)', async () => {
    const rt = makeRuntime({ currentPhase: 'day_vote' });
    const gs = makeGameStore(rt, { stopAfterCalls: 3 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    // Should post vote narrative to eventLog
    const narratives = getNarrativeTexts(rt);
    assert.ok(
      narratives.some((n) => n.includes('投票')),
      'should post vote narrative',
    );

    // All 7 alive seats should be woken
    assert.equal(wakeCat.calls.length, 7, 'should wake all 7 voters');

    // Should call waitForAllActions (parallel wait, not sequential waitForAction)
    assert.equal(actionNotifier.calls.waitForAllActions.length, 1, 'should use waitForAllActions (parallel)');
    assert.equal(actionNotifier.calls.waitForAction.length, 0, 'should NOT use waitForAction for vote');
    const allSeatIds = actionNotifier.calls.waitForAllActions[0].seatIds.sort();
    assert.deepEqual(allSeatIds, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
    assert.equal(actionNotifier.calls.waitForAllActions[0].timeout, TIME_BUDGETS.votePerVoter);
  });

  // --- Global timeout ---

  it('global timeout: posts timeout narrative and breaks loop', async () => {
    // createdAt 31 minutes ago → should trigger global timeout
    const rt = makeRuntime({ createdAt: Date.now() - 31 * 60_000 });
    // Return playing runtime forever (timeout should break the loop)
    const gs = makeGameStore(rt, { stopAfterCalls: 100 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    const narratives = getNarrativeTexts(rt);
    assert.ok(
      narratives.some((n) => n.includes('30 分钟')),
      'should post global timeout narrative',
    );
    assert.equal(wakeCat.calls.length, 0, 'should not wake any cats after timeout');
  });

  // --- Lifecycle ---

  it('stopLoop aborts the running game loop', async () => {
    // Use a store that keeps returning 'playing' forever
    const gs = makeGameStore(runtime, { stopAfterCalls: 100 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));

    // After stop, actionNotifier.cleanup should have been called
    assert.ok(actionNotifier.calls.cleanup.includes('game-001'), 'cleanup should be called on loop exit');
  });

  it('stopAllLoops aborts all running game loops', async () => {
    const gs = makeGameStore(runtime, { stopAfterCalls: 100 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 50));
    driver.stopAllLoops();
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(actionNotifier.calls.cleanup.includes('game-001'), 'cleanup should be called after stopAll');
  });

  it('recoverActiveGames starts loops for all active games', async () => {
    const rt2 = makeRuntime({ gameId: 'game-002', threadId: 'thread-002' });
    const gs = {
      listActiveGames: async () => [runtime, rt2],
      getGame: async (id) => {
        // Return ended immediately so loops don't hang
        const rt = id === 'game-001' ? runtime : rt2;
        return { ...rt, status: 'ended' };
      },
      createGame: async (r) => r,
      getActiveGame: async () => null,
      updateGame: async () => {},
      endGame: async () => {},
    };
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    const count = await driver.recoverActiveGames();
    assert.equal(count, 2, 'should return count of recovered games');

    // Give loops time to start and exit
    await new Promise((r) => setTimeout(r, 200));
  });

  // --- Narrative events structure ---

  it('narrative events have correct structure (type, scope, payload)', async () => {
    const driver = new GameNarratorDriver({ gameStore, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(runtime.eventLog.length > 0, 'should have events in eventLog');
    for (const event of runtime.eventLog.filter((e) => e.type === 'narrative')) {
      assert.equal(event.type, 'narrative', 'event type should be narrative');
      assert.equal(event.scope, 'public', 'narrative scope should be public');
      assert.ok(event.payload.text.length > 0, 'narrative payload.text should not be empty');
      assert.ok(event.eventId, 'event should have an eventId');
      assert.equal(event.round, 1, 'event round should match runtime');
      assert.equal(event.phase, 'night_wolf', 'event phase should match runtime');
      assert.ok(event.timestamp > 0, 'event should have a timestamp');
    }
  });

  it('postNarrative broadcasts game state via orchestrator', async () => {
    const driver = new GameNarratorDriver({ gameStore, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(orchestrator.calls.length > 0, 'should have broadcast game state');
    for (const gameId of orchestrator.calls) {
      assert.equal(gameId, 'game-001', 'broadcast should target correct gameId');
    }
    assert.ok(orchestrator.calls.length >= 2, 'should broadcast at least twice (open + close)');
  });

  it('postNarrative reads fresh state and increments version (OCC safe)', async () => {
    const rt = makeRuntime();
    const initialVersion = rt.version;
    const gs = makeGameStore(rt, { stopAfterCalls: 4 });
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));
    driver.stopLoop('game-001');
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(rt.version > initialVersion, 'version should be incremented by narrative events');
    assert.ok(gs.updates.length > 0, 'updateGame should have been called');
    for (const updated of gs.updates) {
      assert.ok(updated.version > initialVersion, 'each updateGame call should have incremented version');
    }
  });

  // --- Game ended externally ---

  it('loop exits when game status is not playing', async () => {
    const gs = {
      ...makeGameStore(runtime),
      getGame: async () => ({ ...runtime, status: 'ended' }),
      listActiveGames: async () => [],
    };
    const driver = new GameNarratorDriver({ gameStore: gs, orchestrator, wakeCat, actionNotifier });
    driver.startLoop('game-001');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(wakeCat.calls.length, 0, 'should not wake cats when game is ended');
    assert.ok(actionNotifier.calls.cleanup.includes('game-001'), 'cleanup called on exit');
  });
});
