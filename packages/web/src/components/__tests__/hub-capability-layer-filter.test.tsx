import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { threads: unknown[] }) => unknown) => selector({ threads: [] }),
}));

import { HubCapabilityTab } from '@/components/HubCapabilityTab';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MOCK_BOARD = {
  items: [
    { id: 'mcp-a', type: 'mcp', source: 'external', enabled: true, cats: {}, layer: 'L1' },
    { id: 'skill-b', type: 'skill', source: 'cat-cafe', enabled: true, cats: {}, layer: 'L2', category: 'core' },
    { id: 'ext-c', type: 'skill', source: 'external', enabled: true, cats: {}, layer: 'L3' },
  ],
  catFamilies: [],
  projectPath: '/test',
};

describe('F146-D: HubCapabilityTab layer filter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockResolvedValue(jsonResponse(MOCK_BOARD));
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.clearAllMocks();
  });

  it('renders layer filter chips', async () => {
    await act(async () => {
      root.render(<HubCapabilityTab />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const html = container.innerHTML;
    expect(html).toContain('层级');
    expect(html).toContain('L1 MCP');
    expect(html).toContain('L2 Skill');
    expect(html).toContain('L3 扩展');
  });
});
