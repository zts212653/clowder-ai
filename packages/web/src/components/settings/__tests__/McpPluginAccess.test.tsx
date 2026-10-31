import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ toggle: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../useCapabilityState', () => ({
  useCapabilityState: () => ({
    items: [
      {
        id: 'plugin:dev.music:native',
        type: 'mcp',
        source: 'plugin',
        pluginId: 'dev.music',
        enabled: true,
        globalEnabled: true,
        cats: { codex: true },
        accessManagedByPlugin: true,
        mcpServer: { transport: 'stdio', envKeys: [] },
      },
    ],
    loading: false,
    error: null,
    toggling: null,
    disabling: null,
    catFamilies: [{ id: 'maine', name: '缅因猫', catIds: ['codex'] }],
    knownProjects: [],
    resolvedProjectPath: '/host',
    projectPath: null,
    handleToggle: state.toggle,
    refetch: vi.fn(),
    switchProject: vi.fn(),
    setError: vi.fn(),
  }),
}));
vi.mock('../useDriftSync', () => ({
  useDriftSync: () => ({ scopeIssues: [], scopesWithIssues: [], syncing: false }),
}));
vi.mock('../AllProjectsSyncBanner', () => ({ AllProjectsSyncBanner: () => null }));

import { McpManageContent } from '../McpManageContent';

it('shows local plugin ownership without offering switches that would create persistent capability policy', () => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<McpManageContent />));
    expect(host.textContent).toContain('启用或停用此工具，请前往插件集成。');
    const globalSwitch = host.querySelector<HTMLButtonElement>('button[title="请在插件集成中管理"]');
    expect(globalSwitch?.disabled).toBe(true);
    act(() => globalSwitch?.click());
    act(() => host.querySelector<HTMLButtonElement>('button[title="按猫开关"]')?.click());
    const switches = [...host.querySelectorAll<HTMLButtonElement>('button[data-enabled]')];
    expect(switches).toHaveLength(2);
    for (const button of switches) {
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(state.toggle).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
