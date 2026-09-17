// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUBBLE_SAVE_FAILED_NOTICE, BUBBLE_UNSAVED_NOTICE, BubbleToggle } from '../BubbleToggle';

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
  let onChanged: ReturnType<typeof vi.fn>;

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
    onChanged = vi.fn();
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

  it('discloses 本次生效、未保存 when the .env write was skipped or failed', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ persisted: false }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNSAVED_NOTICE);
    // The hot update really did apply in-process, so the parent is still told.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('treats a missing persisted flag as unsaved instead of assuming success', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ config: {} }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_UNSAVED_NOTICE);
  });

  it('reports a rejected update without claiming the value changed', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
    render();

    clickToggle();
    await flush();

    expect(container.textContent).toContain(BUBBLE_SAVE_FAILED_NOTICE);
    expect(onChanged).not.toHaveBeenCalled();
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
  });
});
