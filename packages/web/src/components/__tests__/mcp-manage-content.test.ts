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
    tools: [{ name: 'draw_frame', description: 'Render a Pencil frame' }],
    mcpServer: {
      transport: 'stdio' as const,
      resolver: 'pencil',
      command: 'node',
      args: ['dist/pencil.js'],
      env: { PENCIL_TOKEN: '••••••' },
      envKeys: ['PENCIL_TOKEN'],
    },
    layer: 'L1' as const,
  },
  {
    id: 'custom-mcp',
    type: 'mcp' as const,
    source: 'external' as const,
    enabled: true,
    cats: { opus: true },
    description: 'External MCP',
    mcpServer: {
      transport: 'stdio' as const,
      command: 'npx',
      args: ['custom-mcp'],
      env: { API_KEY: '••••••' },
      headers: { Authorization: '••••••' },
    },
    layer: 'L1' as const,
  },
  {
    id: 'cross-cat-handoff',
    type: 'skill' as const,
    source: 'cat-cafe' as const,
    enabled: true,
    cats: { opus: true },
    description: 'Should stay hidden on the MCP settings page',
    layer: 'L2' as const,
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
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ threads: mockThreads }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { McpManageContent } from '../settings/McpManageContent';
import { SettingsContent } from '../settings/SettingsContent';

let mockThreads: Array<{ id: string; projectPath: string; lastActiveAt: number }> = [];

describe('McpManageContent', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockThreads = [];
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(ITEMS_RESPONSE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderContent() {
    await act(async () => {
      root.render(React.createElement(McpManageContent));
    });
  }

  async function renderSettingsContent() {
    await act(async () => {
      root.render(React.createElement(SettingsContent, { section: 'mcp' }));
    });
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders source-style MCP cards without leaking skill sections', async () => {
    await renderContent();

    expect(container.textContent).toContain('新增 MCP');
    expect(container.textContent).toContain('pencil');
    expect(container.textContent).toContain('custom-mcp');
    expect(container.textContent).not.toContain('cross-cat-handoff');
  });

  it('uses the settings section header without duplicating MCP titles', async () => {
    await renderSettingsContent();

    const mcpHeadings = Array.from(container.querySelectorAll('h2')).filter(
      (heading) => heading.textContent === 'MCP 管理',
    );
    expect(mcpHeadings).toHaveLength(1);
    expect(container.textContent).toContain('新增 MCP');
  });

  it('requests capability data without probe (F249: lazy-load tools in modal)', async () => {
    await renderContent();

    // F249 §8.4: list must NOT probe tools — no probe=true in query.
    // DriftBanner / useDriftSync may fire their own fetch first, so find by URL not index.
    const capCall = mockFetch.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).startsWith('/api/capabilities'),
    );
    expect(capCall).toBeTruthy();
    expect(capCall![0]).toBe('/api/capabilities');
  });

  it('opens managed MCP cards in a read-only modal (tools lazy-loaded)', async () => {
    await renderContent();

    await act(async () => {
      buttonByText('pencil').click();
    });

    expect(container.querySelector('[data-testid="mcp-config-modal"]')).toBeTruthy();
    expect(container.textContent).toContain('PENCIL_TOKEN');
    // F249 §8.4: tools are NOT preloaded in list response — the modal auto-probes
    // via POST /api/mcp/:id/tools on mount. At render time, tools section
    // shows placeholder text, not the tool names from the list response.
    expect(container.textContent).not.toContain('保存');
  });

  it('omits unchanged redacted env and headers when saving external MCP edits', async () => {
    await renderContent();

    await act(async () => {
      buttonByText('custom-mcp').click();
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }).mockResolvedValueOnce(ITEMS_RESPONSE);

    await act(async () => {
      buttonByText('保存').click();
    });

    const installCall = mockFetch.mock.calls.find((args: unknown[]) => args[0] === '/api/capabilities/mcp/install');
    expect(installCall).toBeTruthy();
    const body = JSON.parse((installCall?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body.id).toBe('custom-mcp');
    expect(body.command).toBe('npx');
    expect(body.args).toEqual(['custom-mcp']);
    expect(body).not.toHaveProperty('env');
    expect(body).not.toHaveProperty('headers');
    expect(JSON.stringify(body)).not.toContain('••••••');
  });

  it('shows configured-owner errors from MCP preview', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/capabilities/mcp/preview') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: 'Capability writes can only be modified by the configured owner' }),
        };
      }
      return ITEMS_RESPONSE;
    });
    await renderContent();

    await act(async () => {
      buttonByText('新增 MCP').click();
    });
    const inputs = Array.from(container.querySelectorAll('input'));
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'new-mcp');
      setInputValue(inputs[1] as HTMLInputElement, 'npx');
    });

    await act(async () => {
      buttonByText('预览').click();
    });

    expect(container.textContent).toContain('configured owner');
    expect(container.textContent).not.toContain('DEFAULT_OWNER_USER_ID');
  });

  it('hard-deletes external MCP on uninstall', async () => {
    // useConfirm is globally mocked (test-setup.ts) to resolve true,
    // replacing the old window.confirm spy.
    await renderContent();

    const trashButtons = Array.from(container.querySelectorAll('button[title="卸载此 MCP"]'));
    expect(trashButtons.length).toBe(1);

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }).mockResolvedValueOnce(ITEMS_RESPONSE);

    await act(async () => {
      (trashButtons[0] as HTMLButtonElement).click();
    });

    const deleteCalls = mockFetch.mock.calls.filter(
      (args: unknown[]) => (args[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toContain('/api/capabilities/mcp/custom-mcp?');
    expect(deleteCalls[0][0]).toContain('hard=true');
  });

  it('renders plugin-owned MCP resources as readonly and routes management to plugins', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            ...MOCK_ITEMS[1],
            id: 'plugin:weixin-mp:mcp',
            source: 'external',
            pluginId: 'weixin-mp',
            description: 'Plugin owned MCP',
          },
        ],
        catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
        projectPath: '/test/project',
        skillHealth: null,
      }),
    });

    await renderContent();

    const card = container.querySelector('.settings-resource-card');
    expect(card?.textContent).toContain('Plugin owned MCP');
    expect(card?.textContent).toContain('由插件 weixin-mp 管理');
    expect(card?.querySelector('a[href="/settings?s=plugins"]')).toBeTruthy();

    const toggle = card?.querySelector('.settings-resource-toggle') as HTMLButtonElement | null;
    expect(toggle?.disabled).toBe(true);
    expect(card?.querySelector('button[title="卸载此 MCP"]')).toBeFalsy();
    expect(card?.querySelector('button[title="按猫开关"]')).toBeFalsy();

    mockFetch.mockClear();
    await act(async () => {
      toggle?.click();
    });

    expect(
      mockFetch.mock.calls.some(
        (args: unknown[]) => args[0] === '/api/capabilities' && (args[1] as { method?: string })?.method === 'PATCH',
      ),
    ).toBe(false);
  });

  it('ignores stale project-switch responses when a newer selection resolves first', async () => {
    mockThreads = [
      { id: 'slow-thread', projectPath: '/tmp/slow-project', lastActiveAt: 2 },
      { id: 'fast-thread', projectPath: '/tmp/fast-project', lastActiveAt: 1 },
    ];
    type CapabilitiesPayload = Awaited<ReturnType<(typeof ITEMS_RESPONSE)['json']>>;
    let resolveSlowJson!: (value: CapabilitiesPayload) => void;
    const slowJson = new Promise<CapabilitiesPayload>((resolve) => {
      resolveSlowJson = resolve;
    });
    const slowResponse = {
      ok: true,
      json: () => slowJson,
    };
    const fastResponse = {
      ok: true,
      json: async () => ({
        items: [{ ...MOCK_ITEMS[1], id: 'fast-mcp' }],
        catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
        projectPath: '/tmp/fast-project',
        skillHealth: null,
      }),
    };
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes(encodeURIComponent('/tmp/slow-project'))) return slowResponse;
      if (url.includes(encodeURIComponent('/tmp/fast-project'))) return fastResponse;
      return ITEMS_RESPONSE;
    });

    await renderContent();
    const selector = container.querySelector('#cap-project-select') as HTMLSelectElement;
    expect(selector).toBeTruthy();

    await act(async () => {
      selector.value = '/tmp/slow-project';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      selector.value = '/tmp/fast-project';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('fast-mcp');

    await act(async () => {
      resolveSlowJson({
        items: [{ ...MOCK_ITEMS[1], id: 'slow-mcp' }],
        catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
        projectPath: '/tmp/slow-project',
        skillHealth: null,
      });
      await slowJson;
    });

    expect(container.textContent).toContain('fast-mcp');
    expect(container.textContent).not.toContain('slow-mcp');
  });
});
