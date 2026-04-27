import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));
vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: () => void }) => unknown) => selector({ addToast: () => {} }),
}));

import { HubSkillsTab } from '@/components/HubSkillsTab';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MOCK_SKILLS = {
  skills: [
    {
      name: 'test-skill',
      category: 'test',
      trigger: 'test',
      mounts: { claude: true, codex: true, gemini: true, kimi: true },
      requiresMcp: [
        { id: 'pencil', status: 'ready' },
        { id: 'missing-mcp', status: 'missing' },
      ],
    },
  ],
  summary: { total: 1, allMounted: true, registrationConsistent: true },
  staleness: null,
  conflicts: [],
};

describe('F146-D: HubSkillsTab install missing MCP', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockResolvedValue(jsonResponse(MOCK_SKILLS));
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.clearAllMocks();
  });

  it('renders 补齐 button next to missing MCP dep', async () => {
    await act(async () => {
      root.render(<HubSkillsTab />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const html = container.innerHTML;
    expect(html).toContain('补齐');
    expect(html).toContain('missing-mcp');
  });

  it('does not render 补齐 button next to ready MCP dep', async () => {
    await act(async () => {
      root.render(<HubSkillsTab />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const buttons = container.querySelectorAll('button');
    const installButtons = [...buttons].filter((b) => b.textContent === '补齐');
    expect(installButtons).toHaveLength(1);
  });
});
