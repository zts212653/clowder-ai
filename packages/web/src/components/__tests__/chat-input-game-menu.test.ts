import { describe, expect, it } from 'vitest';
import { detectMenuTrigger } from '@/components/chat-input-options';

describe('composer after legacy game retirement', () => {
  it.each(['/g', '/game', '/game ', '/GAME'])('does not open a game menu for %s', (input) => {
    expect(detectMenuTrigger(input, input.length)).toBeNull();
  });

  it('keeps mention completion available', () => {
    expect(detectMenuTrigger('hello @opus', 11)).toEqual({ type: 'mention', start: 6, filter: 'opus' });
  });
});
