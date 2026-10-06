// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUBBLE_SAVE_FAILED_NOTICE,
  BUBBLE_UNCONFIRMED_NOTICE,
  BUBBLE_UNSAVED_NOTICE,
  BubbleToggle,
} from '../BubbleToggle';

const apiFetch = vi.fn();
const fetchGlobalBubbleDefaults = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ fetchGlobalBubbleDefaults }) },
}));

describe('BubbleToggle persistence disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChanged: ReturnType<typeof vi.fn<() => void>>;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onChanged = vi.fn<() => void>();
    apiFetch.mockReset();
    fetchGlobalBubbleDefaults.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(value: 'expanded' | 'collapsed' = 'collapsed') {
    act(() => {
      root.render(
        <BubbleToggle label="CLI 气泡默认" value={value} configKey="ui.bubble.cliOutput" onChanged={onChanged} />,
      );
    });
  }

  function clickToggle() {
    const button = container.querySelector('button');
    if (!button) throw new Error('toggle button not rendered');
    act(() => {
      button.click();
    });
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('stays quiet when the server confirms the value was persisted', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ persisted: true }) });
    render();

    clickToggle();
    await flush();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('未保存');
  });

  it('keeps the explicit persisted:false disclosure', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ persisted: false }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNSAVED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNCONFIRMED_NOTICE);
    // The hot update really did apply in-process, so the parent is still told.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('treats a missing persisted flag as unconfirmed, not as unsaved', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ config: {} }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNCONFIRMED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNSAVED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_SAVE_FAILED_NOTICE);
    // An unknown outcome is reconciled against the server instead of asserted.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable success body as unconfirmed', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new TypeError('invalid json')),
    });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNCONFIRMED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNSAVED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_SAVE_FAILED_NOTICE);
  });

  it('reports the app’s own 4xx rejection, which is validated before any write', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: 'boom' }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_SAVE_FAILED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNCONFIRMED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNSAVED_NOTICE);
  });

  // A gateway 5xx (or a proxy 408) can arrive after the PATCH already landed
  // upstream, so it proves nothing about the stored value. Only the app's own
  // 4xx rejection may claim "设置未改变".
  it.each([500, 502, 503, 504, 408])('treats a %i response as unconfirmed, not "unchanged"', async (status) => {
    apiFetch.mockResolvedValue({ ok: false, status, json: () => Promise.resolve({ error: 'gateway' }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNCONFIRMED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_SAVE_FAILED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNSAVED_NOTICE);
    // The write may have landed, so re-read the server to settle the UI.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a lost response as unconfirmed instead of asserting 设置未改变', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNCONFIRMED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_SAVE_FAILED_NOTICE);
    expect(container.textContent).not.toContain(BUBBLE_UNSAVED_NOTICE);
    // The PATCH may have landed; re-read the server so the UI can settle.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not leak a network error into the confirmed-unsaved wording', async () => {
    apiFetch.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));
    render();

    clickToggle();
    await flush();

    expect(container.textContent).not.toContain('设置未改变');
    expect(container.textContent).not.toContain('未保存');
  });

  it('clears the notice after a later successful save', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ persisted: false }) });
    render();
    clickToggle();
    await flush();
    expect(container.textContent).toContain(BUBBLE_UNSAVED_NOTICE);

    apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ persisted: true }) });
    clickToggle();
    await flush();

    expect(container.textContent).not.toContain('未保存');
    expect(container.textContent).not.toContain(BUBBLE_UNCONFIRMED_NOTICE);
  });
});
