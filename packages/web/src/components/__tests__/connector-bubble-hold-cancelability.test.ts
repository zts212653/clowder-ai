/**
 * The producer-stated cancelability contract, as the rendered card applies it.
 *
 * `hold-card-cancelability.test.ts` pins the rule; this pins the wiring that
 * reaches it — `ConnectorBubble → collectHoldCards → readHoldCardCancelability
 * → decideHoldCancelEntry → HoldBallCancelButton`. Every case below answers the
 * status probe with 500, because the defect this fixes only ever appeared when
 * the probe could not answer: the card fell back to guessing from
 * `source.meta.phase` and kept live cancel controls on a hold that had ended.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(),
}));

describe('ConnectorBubble hold cancelability contract', () => {
  const mockApiFetch = vi.mocked(apiFetch);
  const BASE_TS = 1_780_000_000_000;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    // The probe is down for every case here. A fresh Response per call: a body
    // is single-use, and each mounted card probes once.
    mockApiFetch.mockImplementation(async () => new Response('upstream failure', { status: 500 }));
  });

  /** One hold-ball card. `cancelable` omitted = written before this contract. */
  function holdCard(id: string, offsetMs: number, cancelable?: boolean): ChatMessage {
    return {
      id,
      type: 'connector',
      content: `hold card ${id}`,
      timestamp: BASE_TS + offsetMs,
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: 'hold-ball',
        meta: { taskId: 'hold-ball-contract', ...(cancelable === undefined ? {} : { cancelable }) },
      },
    } as ChatMessage;
  }

  /** Renders one card of the hold against the whole timeline, isolated. */
  async function renderCard(message: ChatMessage, timelineMessages: readonly ChatMessage[]): Promise<string> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(ConnectorBubble, { message, timelineMessages }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = container.textContent ?? '';
    act(() => root.unmount());
    container.remove();
    return text;
  }

  it('revokes cancel on every card once one card states a terminal, with the probe down', async () => {
    const waiting = holdCard('m-1-waiting', 0, true);
    const terminal = holdCard('m-2-terminal', 1_000, false);
    const timeline = [waiting, terminal];

    const waitingText = await renderCard(waiting, timeline);
    const terminalText = await renderCard(terminal, timeline);

    for (const text of [waitingText, terminalText]) {
      expect(text).not.toContain('取消持球');
      expect(text).not.toContain('取消并反馈');
      expect(text).toContain('已结束');
    }
  });

  it('keeps exactly one cancel entry — never two, never zero — while the hold is active', async () => {
    const cards = [holdCard('m-a', 0, true), holdCard('m-b', 1_000, true), holdCard('m-c', 2_000, true)];

    // Sequential on purpose: overlapping `act()` scopes corrupt React's act
    // bookkeeping and the next render commits nothing.
    const texts: string[] = [];
    for (const card of cards) texts.push(await renderCard(card, cards));
    const withCancel = texts.filter((text) => text.includes('取消持球'));

    expect(withCancel).toHaveLength(1);
    // A non-owner withholds the action only. Losing the card entirely would
    // drop the status line an earlier contract test already depends on.
    expect(texts.every((text) => text.includes('hold card'))).toBe(true);
  });

  it('leaves the probe authoritative when no card states a terminal', async () => {
    const legacy = holdCard('m-legacy', 0);

    const text = await renderCard(legacy, [legacy]);

    // Fail-open is correct here and only here: nothing local says the hold ended,
    // so a 500 must not silently strip a live hold's only cancel entry.
    expect(text).toContain('取消持球');
  });
});
