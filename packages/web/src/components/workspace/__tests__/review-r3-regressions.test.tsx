import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { MeetingShareControl } from '../MeetingShareControl';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ kind: 'available', intent: {}, sharing: false, inputLabel: 'RAW INPUT' }),
  })),
}));

describe('R3 independent regression probes', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { React?: typeof React }).React = React;
    writeShellPresentation('classic');
    writeShellLanguage('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as { React?: typeof React }).React;
  });

  it('classic share control neither reads nor subscribes to the v2 language preference', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const subscribe = vi.spyOn(window, 'addEventListener');
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
    expect(container.textContent).toContain('Share transcript');
    expect({
      reads: read.mock.calls.filter(([key]) => key === 'cat-cafe:shell-language').length,
      subscriptions: subscribe.mock.calls.filter(([event]) => event === 'cat-cafe:shell-language-sync').length,
    }).toEqual({ reads: 0, subscriptions: 0 });
  });
});
