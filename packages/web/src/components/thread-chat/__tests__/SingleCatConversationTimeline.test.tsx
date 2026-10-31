import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TOOLTIP_CONTENT_DELAY_MS,
  APP_TOOLTIP_DELAY_MS,
  AppTooltip,
  resetAppTooltipWarmState,
} from '@/components/AppTooltip';
import type { ChatMessage } from '@/stores/chat-types';
import { writeShellLanguage } from '../../shell/shell-language';
import { SingleCatConversationTimeline } from '../SingleCatConversationTimeline';
import type { SingleCatConversationProjection } from '../single-cat-conversation-projection';

function message(id: string, timestamp: number): ChatMessage {
  return { id, type: id === 'response' || id === 'standalone' ? 'assistant' : 'user', content: id, timestamp };
}

const read = message('read', new Date('2026-10-16T05:08:00-07:00').getTime());
const unknown = message('unknown', new Date('2026-10-16T05:09:00-07:00').getTime());
const response = message('response', new Date('2026-10-16T05:10:00-07:00').getTime());
const standalone = message('standalone', new Date('2026-10-16T05:11:00-07:00').getTime());
const queued = message('queued', new Date('2026-10-16T05:12:00-07:00').getTime());

const projection: SingleCatConversationProjection = {
  hasEvidence: true,
  blocks: [
    {
      kind: 'execution',
      key: 'execution:response',
      startedAt: new Date('2026-10-16T05:10:00-07:00').getTime(),
      invocationId: 'invocation-response',
      response,
      readInputs: [{ message: read, evidence: 'read', readAt: read.timestamp + 1000, source: 'response' }],
      unconfirmedInputs: [{ message: unknown, evidence: 'unconfirmed', source: 'response' }],
    },
    { kind: 'standalone-output', key: 'output:standalone', message: standalone },
    {
      kind: 'pending-inputs',
      key: 'pending:opus',
      inputs: [{ message: queued, evidence: 'unconfirmed', source: 'queue' }],
    },
  ],
};

describe('SingleCatConversationTimeline', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    writeShellLanguage('zh');
    resetAppTooltipWarmState();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    resetAppTooltipWarmState();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function pointer(
    element: Element,
    type: 'pointerover' | 'pointerout' | 'pointerdown' | 'pointerup',
    pointerType = 'mouse',
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    if (type === 'pointerout') Object.defineProperty(event, 'relatedTarget', { value: document.body });
    act(() => element.dispatchEvent(event));
  }

  async function render() {
    await act(async () =>
      root.render(
        <SingleCatConversationTimeline
          projection={projection}
          renderMessage={(item, index, total) => (
            <div data-rendered-message={item.id} data-index={index} data-total={total}>
              {item.content}
            </div>
          )}
        />,
      ),
    );
  }

  it('renders one execution line, normal confirmed inputs, a faded unknown section, and whole outputs', async () => {
    await render();

    const execution = host.querySelector('[data-conversation-execution="response"]');
    expect(execution?.querySelector('[data-conversation-execution-time]')?.textContent).toBe('05:10');
    expect(execution?.querySelector('[data-conversation-input-evidence="read"]')?.textContent).toContain('read');
    expect(execution?.querySelector('[data-conversation-input-evidence="read"]')?.getAttribute('data-read-at')).toBe(
      String(read.timestamp + 1000),
    );
    expect(execution?.querySelector('[data-conversation-unconfirmed-divider]')?.textContent).toContain('未确认读到');
    expect(execution?.querySelector('[data-conversation-input-evidence="unconfirmed"]')?.textContent).toContain(
      'unknown',
    );
    expect(execution?.querySelector('[data-conversation-output="response"]')?.textContent).toContain('response');
    expect(host.querySelector('[data-conversation-output="standalone"]')?.textContent).toContain('standalone');
    expect(host.querySelector('[data-conversation-pending]')?.textContent).toContain('queued');
    expect(host.querySelectorAll('[data-rendered-message]')).toHaveLength(5);
    expect(host.querySelector('[data-rendered-message="queued"]')?.getAttribute('data-total')).toBe('5');
  });

  it('updates the evidence words with the shell language', async () => {
    await render();
    expect(host.textContent).toContain('未确认读到');

    await act(async () => writeShellLanguage('en'));

    expect(host.textContent).toContain('Read not confirmed');
  });

  it('keeps confirmed-read evidence from owning message-row pointer, focus, and touch events', async () => {
    vi.useFakeTimers();
    const plainAction = vi.fn();
    await act(async () =>
      root.render(
        <SingleCatConversationTimeline
          projection={{
            hasEvidence: true,
            blocks: [
              {
                kind: 'execution',
                key: 'execution:response',
                startedAt: response.timestamp,
                invocationId: 'invocation-response',
                response,
                readInputs: [{ message: read, evidence: 'read', readAt: read.timestamp + 1000, source: 'response' }],
                unconfirmedInputs: [],
              },
            ],
          }}
          renderMessage={(item) =>
            item.id === 'read' ? (
              <div data-rendered-message={item.id}>
                <AppTooltip label="Reply action" side="top">
                  <button type="button" data-testid="nested-tooltip-action">
                    reply
                  </button>
                </AppTooltip>
                <button type="button" data-testid="plain-action" onClick={plainAction}>
                  plain
                </button>
              </div>
            ) : (
              <div data-rendered-message={item.id}>{item.content}</div>
            )
          }
        />,
      ),
    );

    const nested = host.querySelector('[data-testid="nested-tooltip-action"]');
    if (!(nested instanceof HTMLButtonElement)) throw new Error('expected nested tooltip action');
    pointer(nested, 'pointerover');
    act(() => vi.advanceTimersByTime(APP_TOOLTIP_DELAY_MS));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Reply action');
    act(() => vi.advanceTimersByTime(APP_TOOLTIP_CONTENT_DELAY_MS - APP_TOOLTIP_DELAY_MS));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Reply action');
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).not.toContain('确认读到');
    pointer(nested, 'pointerout');

    const plain = host.querySelector('[data-testid="plain-action"]');
    if (!(plain instanceof HTMLButtonElement)) throw new Error('expected plain message action');
    const matches = vi.spyOn(Element.prototype, 'matches');
    matches.mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return this === plain;
      return false;
    });
    act(() => plain.focus());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => plain.blur());

    pointer(plain, 'pointerdown', 'touch');
    act(() => vi.advanceTimersByTime(460));
    pointer(plain, 'pointerup', 'touch');
    act(() => plain.click());
    expect(plainAction).toHaveBeenCalledOnce();
  });
});
