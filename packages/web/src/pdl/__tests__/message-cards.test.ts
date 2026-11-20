import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { guessAndRenderCardType, messageCards } from '../message-cards';

const card = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'card', v: 1, title: id, ...extra });
const message = (id: string, blocks: unknown[], more: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'assistant',
    content: '',
    timestamp: 0,
    extra: { rich: { v: 1, blocks } },
    ...more,
  }) as unknown as ChatMessage;

describe('guessAndRenderCardType', () => {
  it('names every card a message carries, in one place', () => {
    const m = message('m1', [
      card('ev', { meta: { domain: 'message-search-answer' } }),
      card('wk', { meta: { kind: 'work_reference', reference: { id: 'w' } } }),
      card('schedule-mutation-p1', {
        actions: [
          { label: 'ok', action: 'schedule:approve', payload: { proposalId: 'p1' } },
          { label: 'no', action: 'schedule:reject', payload: { proposalId: 'p1' } },
        ],
      }),
      card('pr', { actions: [{ label: 'ok', action: 'propose:approve', payload: { proposalId: 'p2' } }] }),
    ]);
    expect(guessAndRenderCardType(m, 't1').map((c) => c.type)).toEqual(['evidence', 'work', 'schedule', 'proposal']);
  });

  it('recognises owner cards by their connector source and the cards carried in message fields', () => {
    const frustration = message('m2', [card('f', { meta: { kind: 'frustration_auto_issue', issueId: 7 } })], {
      source: { connector: 'frustration-auto-issue' },
    });
    const cbauth = message('m3', [card('c', { meta: { kind: 'callback_auth_failure' } })], {
      source: { connector: 'callback-auth' },
    });
    const fields = {
      id: 'm4',
      type: 'assistant',
      content: '',
      timestamp: 0,
      extra: { custodyOfferV1: 'r1', runtimeInteractionCard: { interactionId: 'q1', blockId: 'b1' } },
    } as unknown as ChatMessage;
    expect(guessAndRenderCardType(frustration, 't1')).toMatchObject([{ type: 'frustration', issueId: '7' }]);
    expect(guessAndRenderCardType(cbauth, 't1')).toMatchObject([{ type: 'cbauth', blockId: 'c' }]);
    expect(guessAndRenderCardType(fields, 't1')).toMatchObject([
      { type: 'custody', revision: 'r1' },
      { type: 'ask', interactionId: 'q1', blockId: 'b1' },
    ]);
  });

  it('does not take an owner card from another source', () => {
    const m = message('m5', [card('f', { meta: { kind: 'frustration_auto_issue', issueId: 7 } })]);
    expect(guessAndRenderCardType(m, 't1')).toEqual([]);
    expect(messageCards([m], 't1', 'frustration')).toEqual([]);
  });
});
