import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

import { McpConfigModal } from '@/components/McpConfigModal';
import { apiFetch } from '@/utils/api-client';

describe('McpConfigModal', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders create mode with correct title', async () => {
    await act(async () => {
      root.render(
        React.createElement(McpConfigModal, {
          onSaved: () => {},
          onClose: () => {},
        }),
      );
    });
    expect(container.textContent).toContain('连接至自定义 MCP');
  });

  it('renders edit mode with MCP name', async () => {
    await act(async () => {
      root.render(
        React.createElement(McpConfigModal, {
          editId: 'my-mcp',
          editData: { transport: 'stdio', command: 'test' },
          onSaved: () => {},
          onClose: () => {},
        }),
      );
    });
    expect(container.textContent).toContain('更新 my-mcp');
  });

  it('save sends projectPath in POST payload', async () => {
    const mockFetch = apiFetch as ReturnType<typeof vi.fn>;
    const onSaved = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(McpConfigModal, {
          projectPath: '/my/project',
          editId: 'test-mcp',
          editData: { transport: 'stdio', command: 'server' },
          onSaved,
          onClose: () => {},
        }),
      );
    });

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === '保存',
    ) as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn.click();
    });

    const postCalls = mockFetch.mock.calls.filter(
      (args: unknown[]) => (args[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(postCalls.length).toBe(1);
    const body = JSON.parse((postCalls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body.projectPath).toBe('/my/project');
    expect(body.id).toBe('test-mcp');
  });

  it('save without projectPath omits it from payload', async () => {
    const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

    await act(async () => {
      root.render(
        React.createElement(McpConfigModal, {
          editId: 'no-project-mcp',
          editData: { transport: 'stdio', command: 'server' },
          onSaved: () => {},
          onClose: () => {},
        }),
      );
    });

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === '保存',
    ) as HTMLButtonElement;

    await act(async () => {
      saveBtn.click();
    });

    const postCalls = mockFetch.mock.calls.filter(
      (args: unknown[]) => (args[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(postCalls.length).toBe(1);
    const body = JSON.parse((postCalls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body.projectPath).toBeUndefined();
  });
});
