import type { MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { writeShellLanguage } from '../../shell/shell-language';
import { MessageDispositionDefaultSettings } from '../MessageDispositionDefaultSettings';

const snapshot = (global: MessageDispositionPreferenceSnapshot['global']): MessageDispositionPreferenceSnapshot => ({
  productDefault: 'next_work',
  global,
  thread: null,
  effective: global ?? 'next_work',
  source: global ? 'global' : 'product',
});

const response = (body: MessageDispositionPreferenceSnapshot, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

describe('MessageDispositionDefaultSettings', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    writeShellLanguage('zh');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellLanguage('zh');
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(<MessageDispositionDefaultSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('loads the owner-scoped global default and saves the other choice without a thread id', async () => {
    apiFetch.mockResolvedValueOnce(response(snapshot(null)));
    await render();

    expect(apiFetch).toHaveBeenCalledWith('/api/config/message-disposition');
    expect(host.querySelector<HTMLInputElement>('[data-testid="message-disposition-default-next_work"]')?.checked).toBe(
      true,
    );

    apiFetch.mockResolvedValueOnce(response(snapshot('continue_current')));
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-testid="message-disposition-default-continue_current"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/api/config/message-disposition', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', disposition: 'continue_current' }),
    });
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="message-disposition-default-continue_current"]')?.checked,
    ).toBe(true);
  });

  it('keeps the known value on a rejected save and switches its visible copy with the shell language', async () => {
    apiFetch.mockResolvedValueOnce(response(snapshot('next_work')));
    await render();
    act(() => writeShellLanguage('en'));
    expect(host.textContent).toContain('Default send mode');

    apiFetch.mockResolvedValueOnce(response(snapshot('next_work'), false));
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-testid="message-disposition-default-continue_current"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved');
    expect(host.querySelector<HTMLInputElement>('[data-testid="message-disposition-default-next_work"]')?.checked).toBe(
      true,
    );
  });
});
