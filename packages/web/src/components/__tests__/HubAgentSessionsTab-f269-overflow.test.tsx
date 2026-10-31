import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: apiFetchMock }));

import { HubAgentSessionsTab } from '../HubAgentSessionsTab';

describe('F269 HubAgentSessionsTab diagnostic recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('exposes the complete daemon detail through a bounded disclosure', async () => {
    const detail = `后台任务失败：${'完整诊断上下文'.repeat(40)}：daemon-tail`;
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          daemonShortId: 'daemon-1',
          state: 'failed',
          detail,
          cwd: '/workspace/cat-cafe',
        },
      ],
    });

    await act(async () => root.render(React.createElement(HubAgentSessionsTab)));
    await act(async () => Promise.resolve());

    const rendered = container.querySelector<HTMLElement>('[data-testid="agent-session-detail-daemon-1"]');
    await act(async () => rendered?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(rendered?.querySelector('pre')?.className).toContain('overflow-auto');
    expect(rendered?.textContent).toContain('daemon-tail');
  });
});
