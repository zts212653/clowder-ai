import { describe, expect, it } from 'vitest';
import { detectMenuTrigger, GAME_LIST, WEREWOLF_MODES } from '@/components/chat-input-options';

describe('GAME_LIST (layer 1)', () => {
  it('has exactly one game entry: werewolf', () => {
    expect(GAME_LIST).toHaveLength(1);
    expect(GAME_LIST[0].id).toBe('werewolf');
  });

  it('each game has label and desc', () => {
    for (const game of GAME_LIST) {
      expect(game.label).toBeTruthy();
      expect(game.desc).toBeTruthy();
    }
  });

  it('does not have emoji icons (SVG icon rule)', () => {
    for (const game of GAME_LIST) {
      expect(game).not.toHaveProperty('icon');
    }
  });
});

describe('WEREWOLF_MODES (layer 2)', () => {
  it('has 4 mode entries', () => {
    expect(WEREWOLF_MODES).toHaveLength(4);
    expect(WEREWOLF_MODES.map((m) => m.id)).toEqual(['player', 'god-view', 'player-voice', 'god-view-voice']);
  });

  it('each mode command starts with /game werewolf', () => {
    for (const mode of WEREWOLF_MODES) {
      expect(mode.command).toMatch(/^\/game werewolf /);
    }
  });

  it('voice modes include voice in command', () => {
    const voiceModes = WEREWOLF_MODES.filter((m) => m.id.includes('voice'));
    expect(voiceModes).toHaveLength(2);
    for (const m of voiceModes) {
      expect(m.command).toContain('voice');
    }
  });

  it('does not have emoji icons (SVG icon rule)', () => {
    for (const mode of WEREWOLF_MODES) {
      expect(mode).not.toHaveProperty('icon');
    }
  });
});

describe('detectMenuTrigger /game detection', () => {
  it('detects /g as game trigger', () => {
    expect(detectMenuTrigger('/g', 2)).toEqual({ type: 'game' });
  });

  it('detects /game as game trigger', () => {
    expect(detectMenuTrigger('/game', 5)).toEqual({ type: 'game' });
  });

  it('detects /game with trailing space', () => {
    expect(detectMenuTrigger('/game ', 6)).toEqual({ type: 'game' });
  });

  it('does not detect /game werewolf (too long)', () => {
    expect(detectMenuTrigger('/game werewolf', 14)).toBeNull();
  });

  it('does not detect /games', () => {
    expect(detectMenuTrigger('/games', 6)).toBeNull();
  });

  it('still detects @mention', () => {
    expect(detectMenuTrigger('hello @opus', 11)).toEqual({ type: 'mention', start: 6, filter: 'opus' });
  });

  it('case insensitive: /GAME', () => {
    expect(detectMenuTrigger('/GAME', 5)).toEqual({ type: 'game' });
  });
});
