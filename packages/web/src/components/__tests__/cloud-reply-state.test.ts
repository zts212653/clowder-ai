import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectCloudReply } from '../cloud-reply-state';

const identity = { sourceMessageId: 'source119', targetCatId: 'gpt-pro', dispatchInvocationId: 'attempt119' };
const proof = { v: 1 as const, threadId: 'thread-pro', ...identity };
const source: ChatMessage = {
  id: 'source119',
  type: 'assistant',
  catId: 'codex61-sol',
  content: 'new source',
  timestamp: 1,
};
const answer: ChatMessage = {
  id: 'reply122',
  type: 'assistant',
  from: { kind: 'agent', catId: 'gpt-pro' },
  catId: 'gpt-pro',
  content: '收到 Sol',
  timestamp: 3,
  replyTo: 'source119',
  origin: 'callback',
  extra: { isExplicitPost: true, cloudBridgeReturn: proof },
};

describe('source-bound cloud logical reply', () => {
  it('consumes the exact proof independently from ordering and keeps transport data untouched', () => {
    const before = JSON.stringify([identity, source, answer]);
    for (const messages of [
      [source, answer],
      [answer, source],
    ]) {
      expect(projectCloudReply(identity, 'thread-pro', messages)).toEqual({
        state: 'replied',
        replyMessageId: 'reply122',
      });
    }
    expect(JSON.stringify([identity, source, answer])).toBe(before);
  });
  it.each([
    ['empty placeholder', { content: '' }],
    ['whitespace', { content: '  ' }],
    ['stream in progress', { isStreaming: true }],
    ['hidden reply', { visibility: 'whisper' }],
    ['other source', { replyTo: 'other-source' }],
    ['other cat', { catId: 'gpt-dot' }],
    ['system impostor', { from: { kind: 'system', service: 'test' } }],
    ['withdrawn', { extra: { ...answer.extra, recall: { version: 1, exposure: 'seen', recalledAt: 4 } } }],
    [
      'old attempt',
      { extra: { ...answer.extra, cloudBridgeReturn: { ...proof, dispatchInvocationId: 'old-attempt' } } },
    ],
    ['other thread proof', { extra: { ...answer.extra, cloudBridgeReturn: { ...proof, threadId: 'other-thread' } } }],
  ])('does not settle with %s', (_label, delta) => {
    expect(projectCloudReply(identity, 'thread-pro', [source, { ...answer, ...delta } as ChatMessage])).toEqual({
      state: 'unverified',
    });
  });
  it('distinguishes a historical source reply without proof from a verified attempt', () => {
    expect(projectCloudReply(identity, 'thread-pro', [source, { ...answer, extra: { isExplicitPost: true } }])).toEqual(
      { state: 'source_replied', replyMessageId: 'reply122' },
    );
    expect(projectCloudReply(identity, 'thread-pro', [source])).toEqual({ state: 'unverified' });
    expect(projectCloudReply(identity, 'thread-pro', [answer])).toEqual({ state: 'unverified' });
  });
});
