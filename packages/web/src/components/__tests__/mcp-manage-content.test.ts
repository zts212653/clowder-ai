import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const MOCK_ITEMS = [
  {
    id: 'pencil',
    type: 'mcp' as const,
    source: 'cat-cafe' as const,
    enabled: true,
    cats: {},
    description: 'Pencil design tool',
    mcpServer: { transport: 'stdio', command: 'pencil-server' },
  },
  {
    id: 'custom-mcp',
    type: 'mcp' as const,
    source: 'external' as const,
    enabled: true,
    cats: { opus: true },
    description: 'External MCP',
    mcpServer: { transport: 'streamableHttp', url: 'https://example.com/mcp' },
  },
];

const ITEMS_RESPONSE = {
  ok: true,
  json: async () => ({
    items: MOCK_ITEMS,
    catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
    projectPath: '/test/project',
    skillHealth: null,
  }),
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ threads: [] }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/components/marketplace/marketplace-panel', () => ({
  MarketplacePanel: () => React.createElement('div', null, 'marketplace'),
}));

vi.mock('@/components/McpConfigModal', () => ({
  McpConfigModal: (props: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-modal', 'data-project-path': props.projectPath ?? '' }),
}));

import { McpManageContent } from '@/components/settings/McpManageContent';
import { apiFetch } from '@/utils/api-client';

describe('McpManageContent', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(ITEMS_RESPONSE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders MCP cards after loading', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });
    expect(container.textContent).toContain('pencil');
    expect(container.textContent).toContain('custom-mcp');
    expect(container.textContent).toContain('marketplace');
  });

  it('clicking trash on external MCP calls soft DELETE (no hard=true)', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });

    const trashButtons = container.querySelectorAll('button[title="禁用此 MCP"]');
    expect(trashButtons.length).toBeGreaterThan(0);

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await act(async () => {
      (trashButtons[0] as HTMLButtonElement).click();
    });

    const deleteCalls = mockFetch.mock.calls.filter(
      (args: unknown[]) => (args[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toContain('/api/capabilities/mcp/');
    expect(deleteCalls[0][0]).not.toContain('hard=true');
  });

  it('clicking external MCP card opens config modal', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });

    const cardButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.textContent?.includes('custom-mcp'),
    );
    expect(cardButtons.length).toBeGreaterThan(0);

    await act(async () => {
      cardButtons[0].click();
    });

    const modal = container.querySelector('[data-testid="mock-modal"]');
    expect(modal).toBeTruthy();
  });

  it('no gear/settings icon button exists', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });

    const settingsBtn = container.querySelector('button[title="编辑配置"]');
    expect(settingsBtn).toBeNull();
  });

  it('uses the shared settings resource-card contract for MCP rows and actions', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });

    const card = Array.from(container.querySelectorAll('.settings-resource-card')).find((candidate) =>
      candidate.textContent?.includes('custom-mcp'),
    );
    expect(card).toBeTruthy();
    expect(card?.querySelector('button[title="禁用此 MCP"]')?.className).toContain('settings-resource-action');
    expect(card?.querySelector('button[title="按猫开关"]')?.className).toContain('settings-resource-action');
    expect(card?.querySelector('button[title="禁用"]')?.className).toContain('settings-resource-toggle');
  });

  it('orders MCP card actions as enable switch, per-cat, then disable', async () => {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });

    const card = Array.from(container.querySelectorAll('.settings-resource-card')).find((candidate) =>
      candidate.textContent?.includes('custom-mcp'),
    );
    expect(card).toBeTruthy();

    const actionTitles = Array.from(card?.querySelectorAll('.settings-resource-actions button') ?? []).map((button) =>
      button.getAttribute('title'),
    );
    expect(actionTitles).toEqual(['禁用', '按猫开关', '禁用此 MCP']);
  });
});
