import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFirstWakeBriefing,
  buildRebriefing,
  buildResumeCapsule,
} from '../dist/domains/cats/services/game/briefing.js';

function makeRuntime(overrides = {}) {
  return {
    gameId: 'game-test-001',
    threadId: 'thread-test-001',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: '每晚合议杀一名玩家', nightActionPhase: 'night_wolf' },
        { name: 'seer', faction: 'village', description: '每晚查验一名玩家的身份', nightActionPhase: 'night_seer' },
        {
          name: 'witch',
          faction: 'village',
          description: '持有解药（救人）和毒药（毒人）各一瓶',
          nightActionPhase: 'night_witch',
        },
        { name: 'hunter', faction: 'village', description: '被狼刀死时可开枪带走一人（毒死不可）' },
        { name: 'villager', faction: 'village', description: '普通村民，白天投票放逐' },
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

describe('Briefing Capsule Builder', () => {
  describe('buildFirstWakeBriefing', () => {
    it('wolf briefing includes teammates', () => {
      const rt = makeRuntime();
      const result = buildFirstWakeBriefing({
        gameRuntime: rt,
        seatId: 'P1',
        teammates: [{ catId: 'codex', seatId: 'P2' }],
      });

      assert.ok(result.includes('狼人'), 'should contain role name 狼人');
      assert.ok(result.includes('座位 1'), 'should contain own seat number');
      assert.ok(result.includes('狼队友'), 'should contain teammate section');
      assert.ok(result.includes('座位2'), 'should contain teammate seat');
      assert.ok(result.includes('codex'), 'should contain teammate catId');
    });

    it('seer briefing does NOT include teammates', () => {
      const rt = makeRuntime();
      const result = buildFirstWakeBriefing({
        gameRuntime: rt,
        seatId: 'P3',
      });

      assert.ok(result.includes('预言家'), 'should contain role name');
      assert.ok(result.includes('座位 3'), 'should contain own seat number');
      assert.ok(!result.includes('狼队友'), 'should NOT contain teammate section');
    });

    it('villager briefing is minimal — no teammates, no special night action', () => {
      const rt = makeRuntime({ currentPhase: 'day_discuss' });
      const result = buildFirstWakeBriefing({
        gameRuntime: rt,
        seatId: 'P6',
      });

      assert.ok(result.includes('村民'), 'should contain role name');
      assert.ok(!result.includes('狼队友'), 'should NOT contain teammate section');
    });

    it('includes submit_game_action tool usage with correct params', () => {
      const rt = makeRuntime();
      const result = buildFirstWakeBriefing({
        gameRuntime: rt,
        seatId: 'P1',
        teammates: [{ catId: 'codex', seatId: 'P2' }],
      });

      assert.ok(result.includes('submit_game_action'), 'should mention the tool');
      assert.ok(result.includes('game-test-001'), 'should include gameId');
      assert.ok(result.includes('round: 1'), 'should include round');
      assert.ok(result.includes('night_wolf'), 'should include phase');
      assert.ok(result.includes('seat: 1'), 'should include seat number');
      assert.ok(result.includes('action: "kill"'), 'should include correct action');
      assert.ok(result.includes('nonce'), 'should mention nonce');
    });

    it('round/phase numbers are accurate', () => {
      const rt = makeRuntime({ round: 3, currentPhase: 'night_seer' });
      const result = buildFirstWakeBriefing({
        gameRuntime: rt,
        seatId: 'P3',
      });

      assert.ok(result.includes('第 3 轮'), 'should show round 3');
      assert.ok(result.includes('night_seer'), 'should show current phase');
      assert.ok(result.includes('action: "divine"'), 'seer should have divine action');
    });
  });

  describe('buildResumeCapsule', () => {
    it('shows correct alive/dead after deaths', () => {
      const rt = makeRuntime({
        round: 2,
        currentPhase: 'day_discuss',
        seats: [
          { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
          { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'wolf', alive: false, properties: {} },
          { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'seer', alive: true, properties: {} },
          { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'witch', alive: true, properties: {} },
          { seatId: 'P5', actorType: 'cat', actorId: 'spark', role: 'hunter', alive: false, properties: {} },
          { seatId: 'P6', actorType: 'cat', actorId: 'sonnet', role: 'villager', alive: true, properties: {} },
          { seatId: 'P7', actorType: 'human', actorId: 'you', role: 'villager', alive: true, properties: {} },
        ],
        eventLog: [
          {
            eventId: 'e1',
            round: 1,
            phase: 'night_resolve',
            type: 'dawn_announce',
            scope: 'public',
            payload: { deadSeats: ['P5'] },
            timestamp: 1,
          },
        ],
      });

      const result = buildResumeCapsule({
        gameRuntime: rt,
        seatId: 'P3',
      });

      assert.ok(result.includes('预言家'), 'should contain role');
      assert.ok(result.includes('第 2 轮'), 'should show round 2');
      assert.ok(result.includes('day_discuss'), 'should show phase');
      assert.ok(result.includes('座位3(你)'), 'should mark self as 你');
      assert.ok(!result.includes('spark') || result.includes('已死亡'), 'dead player in dead section');
      assert.ok(result.includes('get_thread_context'), 'should include search hint');
    });

    it('includes tool usage for current phase', () => {
      const rt = makeRuntime({ currentPhase: 'day_vote', round: 2 });
      const result = buildResumeCapsule({
        gameRuntime: rt,
        seatId: 'P1',
      });

      assert.ok(result.includes('submit_game_action'), 'should include tool usage');
      assert.ok(result.includes('action: "vote"'), 'should include vote action');
    });
  });

  describe('buildRebriefing', () => {
    it('includes full identity + state + previousKnowledge', () => {
      const rt = makeRuntime({ round: 3, currentPhase: 'night_seer' });
      const result = buildRebriefing({
        gameRuntime: rt,
        seatId: 'P3',
        previousKnowledge: ['第1夜查验座位1(opus)：狼人', '第2夜查验座位6(sonnet)：好人'],
      });

      assert.ok(result.includes('Session 恢复'), 'should be marked as session recovery');
      assert.ok(result.includes('预言家'), 'should contain role');
      assert.ok(result.includes('座位 3'), 'should contain seat');
      assert.ok(result.includes('第 3 轮'), 'should show round');
      assert.ok(result.includes('你之前获得的信息'), 'should have knowledge section');
      assert.ok(result.includes('座位1(opus)：狼人'), 'should include divine result 1');
      assert.ok(result.includes('座位6(sonnet)：好人'), 'should include divine result 2');
      assert.ok(result.includes('get_thread_context'), 'should include search hint');
    });

    it('wolf rebriefing includes teammates', () => {
      const rt = makeRuntime({ round: 2, currentPhase: 'night_wolf' });
      const result = buildRebriefing({
        gameRuntime: rt,
        seatId: 'P1',
        teammates: [{ catId: 'codex', seatId: 'P2' }],
      });

      assert.ok(result.includes('狼人'), 'should contain wolf role');
      assert.ok(result.includes('狼队友'), 'should contain teammate section');
      assert.ok(result.includes('codex'), 'should contain teammate');
    });

    it('without previousKnowledge omits that section', () => {
      const rt = makeRuntime({ round: 2, currentPhase: 'day_discuss' });
      const result = buildRebriefing({
        gameRuntime: rt,
        seatId: 'P6',
      });

      assert.ok(!result.includes('你之前获得的信息'), 'should not have knowledge section');
    });
  });

  describe('guard consecutive protection rule', () => {
    it('guard briefing mentions the consecutive protection restriction', () => {
      const rt = makeRuntime({
        currentPhase: 'night_guard',
        definition: {
          ...makeRuntime().definition,
          phases: [
            ...makeRuntime().definition.phases,
            { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 45000, autoAdvance: true },
          ],
          roles: [
            ...makeRuntime().definition.roles,
            { name: 'guard', faction: 'village', description: '每晚守护一名玩家', nightActionPhase: 'night_guard' },
          ],
        },
        seats: [
          ...makeRuntime().seats.slice(0, 6),
          { seatId: 'P7', actorType: 'cat', actorId: 'opencode', role: 'guard', alive: true, properties: {} },
        ],
      });

      const result = buildFirstWakeBriefing({ gameRuntime: rt, seatId: 'P7' });
      assert.ok(
        result.includes('不能连续两晚保护同一人'),
        'guard briefing should mention consecutive protection restriction',
      );
    });

    it('guard resume capsule also mentions the restriction', () => {
      const rt = makeRuntime({
        currentPhase: 'night_guard',
        round: 2,
        definition: {
          ...makeRuntime().definition,
          phases: [
            ...makeRuntime().definition.phases,
            { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 45000, autoAdvance: true },
          ],
          roles: [
            ...makeRuntime().definition.roles,
            { name: 'guard', faction: 'village', description: '每晚守护一名玩家', nightActionPhase: 'night_guard' },
          ],
        },
        seats: [
          ...makeRuntime().seats.slice(0, 6),
          { seatId: 'P7', actorType: 'cat', actorId: 'opencode', role: 'guard', alive: true, properties: {} },
        ],
      });

      const result = buildResumeCapsule({ gameRuntime: rt, seatId: 'P7' });
      assert.ok(
        result.includes('不能连续两晚保护同一人'),
        'guard resume should mention consecutive protection restriction',
      );
    });
  });
});
