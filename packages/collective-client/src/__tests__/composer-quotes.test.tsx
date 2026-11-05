// @vitest-environment jsdom
import type { CollectiveMessageQuote } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import { MessageQuoteProvider, useMessageQuotes } from '../message-quote-context.js';

const quote = (id: string): CollectiveMessageQuote => ({
  v: 1,
  kind: 'quote',
  id,
  text: `Selected ${id}`,
  source: {
    kind: 'collective_message',
    serviceInstanceId: 'svc_service01',
    collectiveId: 'col_collective01',
    channelId: 'general',
    eventId: 'evt_source001',
  },
});
function AddQuote({ id }: { id: string }) {
  const actions = useMessageQuotes();
  return (
    <button type="button" onClick={() => actions?.add(quote(id))}>
      Select {id}
    </button>
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('keeps Channel and Topic selection targets separate and restores a sourced quote after reload', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MessageQuoteProvider>
          <AddQuote id="channel" />
          <Composer
            namespace="quote-person"
            channelId="general"
            placeholder="Channel"
            delivery={{ kind: 'idle' }}
            onSend={vi.fn()}
          />
          <MessageQuoteProvider>
            <AddQuote id="topic" />
            <Composer
              namespace="quote-person"
              channelId="general"
              rootEventId="evt_topic0001"
              placeholder="Topic"
              delivery={{ kind: 'idle' }}
              onSend={vi.fn()}
            />
          </MessageQuoteProvider>
        </MessageQuoteProvider>,
      ),
    );
    const choose = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Select topic');
    await act(async () => choose?.click());
    const channel = JSON.parse(localStorage.getItem('collective-draft:quote-person:general:channel') ?? '{}');
    const topic = JSON.parse(localStorage.getItem('collective-draft:quote-person:general:evt_topic0001') ?? '{}');
    expect(channel.contextAttachments).toBeUndefined();
    expect(topic.contextAttachments).toEqual([quote('topic')]);
    await act(async () =>
      root.render(
        <MessageQuoteProvider>
          <Composer
            namespace="quote-person"
            channelId="general"
            rootEventId="evt_topic0001"
            placeholder="Restored"
            delivery={{ kind: 'idle' }}
            onSend={vi.fn()}
          />
        </MessageQuoteProvider>,
      ),
    );
    expect(container.textContent).toContain('Selected topic');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('a late send ACK cannot erase a newly selected quote in the same private draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let finish: (() => void) | undefined;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await act(async () =>
      root.render(
        <MessageQuoteProvider>
          <AddQuote id="first" />
          <AddQuote id="second" />
          <Composer
            namespace="quote-person"
            channelId="general"
            placeholder="Channel"
            delivery={{ kind: 'idle' }}
            onSend={send}
          />
        </MessageQuoteProvider>,
      ),
    );
    const choose = async (text: string) =>
      act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === text)?.click());
    await choose('Select first');
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(send).toHaveBeenCalledWith('', { kind: 'channel' }, false, false, undefined, {
      contextAttachments: [quote('first')],
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="移除引用"]')?.click());
    await choose('Select second');
    await act(async () => finish?.());
    const draft = JSON.parse(localStorage.getItem('collective-draft:quote-person:general:channel') ?? '{}');
    expect(draft.contextAttachments).toEqual([quote('second')]);
    expect(container.textContent).toContain('Selected second');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
