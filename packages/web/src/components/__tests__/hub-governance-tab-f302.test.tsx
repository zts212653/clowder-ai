import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/components/GovernanceInstaller', () => ({
  GovernanceInstaller: ({ projectPath }: { projectPath: string }) => (
    <div data-testid="mock-governance-installer">installer:{projectPath}</div>
  ),
}));

const { HubGovernanceTab } = await import('@/components/HubGovernanceTab');

describe('HubGovernanceTab F302', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('labels discovered projects as not installed and opens an explicit installer instead of auto-syncing', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ threads: [{ projectPath: '/tmp/community/repo' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ unsynced: ['/tmp/community/repo'] }) });

    await act(async () => {
      root.render(<HubGovernanceTab />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('未安装');
    expect(container.textContent).toContain('派遣不会自动写入项目');
    expect(container.textContent).not.toContain('立即同步');
    const configure = [...container.querySelectorAll('button')].find((button) => button.textContent === '配置');
    expect(configure).toBeTruthy();

    await act(async () => configure?.click());
    expect(container.querySelector('[data-testid="mock-governance-installer"]')?.textContent).toContain(
      '/tmp/community/repo',
    );
  });
});
