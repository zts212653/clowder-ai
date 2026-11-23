import { describe, expect, it } from 'vitest';
import { callbackPost } from '../agent-messages/named-target';

describe('watcher callback message identity', () => {
  it('keeps the persisted watcher provenance on live callback messages', () => {
    const watcher = {
      kind: 'nudge' as const,
      sourceInvocationId: 'ordinary-work',
      sourceMessageId: 'original-message',
      watcherInvocationId: 'watcher-work',
    };
    const message = callbackPost(
      {
        type: 'text',
        origin: 'callback',
        catId: 'codex61-sol',
        messageId: 'watcher-message',
        content: '@gemini-argon\n\nA helpful precedent.',
        extra: { watcher, targetCats: ['gemini-argon'], isExplicitPost: true },
      },
      1,
    );
    expect(message?.extra?.watcher).toEqual(watcher);
    expect(message?.extra?.targetCats).toEqual(['gemini-argon']);
  });

  it('does not infer the watcher role from its member or prose', () => {
    const message = callbackPost(
      {
        type: 'text',
        origin: 'callback',
        catId: 'codex61-sol',
        messageId: 'ordinary-message',
        content: '守望猫 · 小太阳',
      },
      1,
    );
    expect(message?.extra?.watcher).toBeUndefined();
  });
});
