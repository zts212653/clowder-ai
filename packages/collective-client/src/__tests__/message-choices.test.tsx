// @vitest-environment jsdom

import type { RichInteractiveBlock } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CollectiveEventEnvelope } from '../client-types.js';
import { MessageChoices } from '../MessageChoices.js';
import { MessageQuoteProvider, useMessageQuotes } from '../message-quote-context.js';

const event: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_choicepeople',
  collectiveId: 'col_choicepeople',
  eventId: 'evt_choicepeople',
  clientEventId: 'choices',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_choices', displayName: 'Member' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '',
  acceptedAt: '2026-10-26T00:00:00.000Z',
};
const block: RichInteractiveBlock = {
  v: 1,
  id: 'public-choices',
  kind: 'interactive',
  interactiveType: 'card-grid',
  allowRandom: true,
  options: [
    { id: 'one', label: '读原文', group: '先看看' },
    { id: 'two', label: '写想法', group: '一起做' },
  ],
};
function QuoteProbe() {
  return <output data-quote="">{useMessageQuotes()?.request?.comment ?? ''}</output>;
}
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (namespace: string) =>
    act(async () =>
      root.render(
        <MessageQuoteProvider namespace={namespace}>
          <MessageChoices block={block} event={event} />
          <QuoteProbe />
        </MessageQuoteProvider>,
      ),
    );
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Expected button: ${label}`);
    await act(async () => button.click());
  };
  return {
    container,
    render,
    click,
    async close() {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      localStorage.clear();
    },
  };
}

it('keeps each person’s pending choice and sourced reply request in their own namespace', async () => {
  const f = await fixture();
  try {
    await f.render('human:A:general');
    await f.click('读原文');
    await f.click('放进回复草稿');
    expect(f.container.querySelector('[data-quote]')?.textContent).toBe('读原文');
    await f.render('human:B:general');
    expect(f.container.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(f.container.querySelector('[data-quote]')?.textContent).toBe('');
    await f.click('写想法');
    await f.render('human:A:general');
    expect(f.container.querySelector('[aria-pressed="true"]')?.textContent).toBe('读原文');
    expect(f.container.querySelector('[data-quote]')?.textContent).toBe('读原文');
  } finally {
    await f.close();
  }
});

it('lets an allowed random choice select an option without publishing or submitting a reply by itself', async () => {
  const f = await fixture();
  try {
    await f.render('human:A:general');
    await f.click('帮我选一个');
    expect(f.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(f.container.querySelector('[data-quote]')?.textContent).toBe('');
    await f.click('放进回复草稿');
    expect(['读原文', '写想法']).toContain(f.container.querySelector('[data-quote]')?.textContent);
    expect(f.container.textContent).toContain('先看看');
    expect(f.container.textContent).toContain('一起做');
  } finally {
    await f.close();
  }
});
