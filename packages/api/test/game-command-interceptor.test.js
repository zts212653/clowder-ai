/**
 * Game Command Interceptor — TDD Red→Green
 *
 * Tests the /game command parser + seat builder bridge.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGameSeats, parseGameCommand, sanitizeCatIds } from '../dist/routes/game-command-interceptor.js';

describe('parseGameCommand', () => {
  it('returns null for non-game messages', () => {
    assert.equal(parseGameCommand('hello world'), null);
    assert.equal(parseGameCommand('/help'), null);
    assert.equal(parseGameCommand('I want to play a game'), null);
  });

  it('parses /game werewolf player', () => {
    const result = parseGameCommand('/game werewolf player');
    assert.deepStrictEqual(result, {
      gameType: 'werewolf',
      humanRole: 'player',
      voiceMode: false,
      playerCount: undefined,
      catIds: undefined,
    });
  });

  it('parses /game werewolf god-view', () => {
    const result = parseGameCommand('/game werewolf god-view');
    assert.deepStrictEqual(result, {
      gameType: 'werewolf',
      humanRole: 'god-view',
      voiceMode: false,
      playerCount: undefined,
      catIds: undefined,
    });
  });

  it('parses /game werewolf player voice', () => {
    const result = parseGameCommand('/game werewolf player voice');
    assert.deepStrictEqual(result, {
      gameType: 'werewolf',
      humanRole: 'player',
      voiceMode: true,
      playerCount: undefined,
      catIds: undefined,
    });
  });

  it('parses /game werewolf god-view voice', () => {
    const result = parseGameCommand('/game werewolf god-view voice');
    assert.deepStrictEqual(result, {
      gameType: 'werewolf',
      humanRole: 'god-view',
      voiceMode: true,
      playerCount: undefined,
      catIds: undefined,
    });
  });

  it('returns null for /game without enough args', () => {
    assert.equal(parseGameCommand('/game'), null);
    assert.equal(parseGameCommand('/game werewolf'), null);
  });

  it('returns null for unknown game type', () => {
    assert.equal(parseGameCommand('/game mahjong player'), null);
  });

  it('returns null for /game status (subcommand)', () => {
    assert.equal(parseGameCommand('/game status'), null);
    assert.equal(parseGameCommand('/game end'), null);
  });

  it('is case-insensitive', () => {
    const result = parseGameCommand('/Game Werewolf God-View Voice');
    assert.deepStrictEqual(result, {
      gameType: 'werewolf',
      humanRole: 'god-view',
      voiceMode: true,
      playerCount: undefined,
      catIds: undefined,
    });
  });

  // AC-C2: Extended lobby config parsing
  it('parses player count from command', () => {
    const result = parseGameCommand('/game werewolf player 9');
    assert.equal(result?.playerCount, 9);
    assert.equal(result?.voiceMode, false);
  });

  it('parses player count + voice', () => {
    const result = parseGameCommand('/game werewolf player 9 voice');
    assert.equal(result?.playerCount, 9);
    assert.equal(result?.voiceMode, true);
  });

  it('parses player count + cat IDs', () => {
    const result = parseGameCommand('/game werewolf player 9 opus,sonnet,codex,gpt52,spark,gemini,gemini25,dare');
    assert.equal(result?.playerCount, 9);
    assert.deepStrictEqual(result?.catIds, ['opus', 'sonnet', 'codex', 'gpt52', 'spark', 'gemini', 'gemini25', 'dare']);
  });

  it('parses player count + cat IDs + voice', () => {
    const result = parseGameCommand('/game werewolf god-view 7 opus,sonnet,codex voice');
    assert.equal(result?.playerCount, 7);
    assert.deepStrictEqual(result?.catIds, ['opus', 'sonnet', 'codex']);
    assert.equal(result?.voiceMode, true);
  });

  // P2: single cat ID (no comma) must still be parsed as catIds
  it('parses single cat ID without comma', () => {
    const result = parseGameCommand('/game werewolf player 9 opus');
    assert.deepStrictEqual(result?.catIds, ['opus']);
  });

  // P2: trailing tokens must not overwrite catIds
  it('ignores trailing tokens after catIds', () => {
    const result = parseGameCommand('/game werewolf player 9 opus,sonnet please');
    assert.deepStrictEqual(result?.catIds, ['opus', 'sonnet']);
  });

  // P1-2: playerCount must be clamped to valid presets
  it('clamps playerCount to nearest valid preset', () => {
    // 5 → too low, should clamp to 6
    assert.equal(parseGameCommand('/game werewolf player 5')?.playerCount, 6);
    // 11 → not a preset, should clamp to 10
    assert.equal(parseGameCommand('/game werewolf player 11')?.playerCount, 10);
    // 999 → way too high, should clamp to 12
    assert.equal(parseGameCommand('/game werewolf player 999')?.playerCount, 12);
    // 0 → clamp to 6
    assert.equal(parseGameCommand('/game werewolf player 0')?.playerCount, 6);
    // Valid presets should pass through
    assert.equal(parseGameCommand('/game werewolf player 6')?.playerCount, 6);
    assert.equal(parseGameCommand('/game werewolf player 9')?.playerCount, 9);
    assert.equal(parseGameCommand('/game werewolf player 12')?.playerCount, 12);
  });
});

describe('sanitizeCatIds', () => {
  const allowedIds = ['opus', 'sonnet', 'codex', 'gpt52', 'gemini'];

  it('filters out unknown cat IDs', () => {
    const result = sanitizeCatIds(['opus', 'fakeUser', 'codex', 'hacker'], allowedIds);
    assert.deepStrictEqual(result, ['opus', 'codex']);
  });

  it('returns all when all are valid', () => {
    const result = sanitizeCatIds(['opus', 'codex', 'gemini'], allowedIds);
    assert.deepStrictEqual(result, ['opus', 'codex', 'gemini']);
  });

  it('returns empty array when all are invalid', () => {
    const result = sanitizeCatIds(['fakeUser1', 'fakeUser2'], allowedIds);
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array for empty input', () => {
    const result = sanitizeCatIds([], allowedIds);
    assert.deepStrictEqual(result, []);
  });
});

describe('buildGameSeats', () => {
  const catIds = ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'dare', 'spark'];

  it('builds 7-player seats with human P1 for player mode', () => {
    const seats = buildGameSeats({
      humanRole: 'player',
      userId: 'owner',
      catIds,
      playerCount: 7,
    });
    assert.equal(seats.length, 7);
    // P1 is human
    assert.equal(seats[0].seatId, 'P1');
    assert.equal(seats[0].actorType, 'human');
    assert.equal(seats[0].actorId, 'owner');
    // P2-P7 are cats
    for (let i = 1; i < 7; i++) {
      assert.equal(seats[i].seatId, `P${i + 1}`);
      assert.equal(seats[i].actorType, 'cat');
    }
    // All alive, empty role
    for (const seat of seats) {
      assert.equal(seat.alive, true);
      assert.equal(seat.role, '');
    }
  });

  it('builds seats with no human seat for god-view mode', () => {
    const seats = buildGameSeats({
      humanRole: 'god-view',
      userId: 'owner',
      catIds,
      playerCount: 7,
    });
    // God-view: human is observer, all 7 seats are cats
    assert.equal(seats.length, 7);
    for (const seat of seats) {
      assert.equal(seat.actorType, 'cat');
    }
  });

  it('rejects when playerCount exceeds catIds length (no seat duplication)', () => {
    assert.throws(
      () =>
        buildGameSeats({
          humanRole: 'god-view',
          userId: 'owner',
          catIds: ['opus', 'sonnet'],
          playerCount: 7,
        }),
      /Not enough cats/,
    );
  });
});
