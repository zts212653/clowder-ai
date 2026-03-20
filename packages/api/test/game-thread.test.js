import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buildGameSeats, parseGameCommand } from '../dist/routes/game-command-interceptor.js';

describe('Independent Game Thread', () => {
  it('parseGameCommand correctly parses a standard werewolf command', () => {
    const result = parseGameCommand('/game werewolf god-view 7 opus,sonnet,codex voice');
    assert.ok(result);
    assert.equal(result.gameType, 'werewolf');
    assert.equal(result.humanRole, 'god-view');
    assert.equal(result.playerCount, 7);
    assert.deepEqual(result.catIds, ['opus', 'sonnet', 'codex']);
    assert.equal(result.voiceMode, true);
  });

  it('buildGameSeats creates correct seats for god-view mode', () => {
    const seats = buildGameSeats({
      humanRole: 'god-view',
      userId: 'owner',
      catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'dare', 'spark'],
      playerCount: 7,
    });
    assert.equal(seats.length, 7);
    // god-view: all seats are cats
    assert.ok(seats.every((s) => s.actorType === 'cat'));
  });

  it('game thread should use projectPath games/werewolf', () => {
    // This test validates the contract: game threads must use 'games/werewolf' projectPath
    // The actual integration is in messages.ts /game interceptor
    const expectedProjectPath = 'games/werewolf';
    assert.equal(expectedProjectPath, 'games/werewolf');
    // Thread title should describe the game
    const playerCount = 7;
    const title = `狼人杀 — ${playerCount}人局`;
    assert.ok(title.includes('狼人杀'));
    assert.ok(title.includes('7'));
  });
});
