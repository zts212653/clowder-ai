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
      name: 'skill-a',
      category: 'cat-a',
      trigger: 'trigger-a',
      mounts: { claude: true, codex: true, gemini: true, kimi: true },
      requiresMcp: [{ id: 'missing-1', status: 'missing' }],
    },
    {
      name: 'skill-b',
      category: 'cat-b',
      trigger: 'trigger-b',
      mounts: { claude: true, codex: true, gemini: true, kimi: true },
      requiresMcp: [{ id: 'missing-2', status: 'missing' }],
    },
  ],
  summary: { total: 2, allMounted: true, registrationConsistent: true },
  staleness: null,
  conflicts: [],
};

describe('F146-D P1-1: install form scoped to one category', () => {
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

  it('clicking 补齐 in one category does NOT show form in other category', async () => {
    await act(async () => {
      root.render(<HubSkillsTab />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const buttons = container.querySelectorAll('button');
    const installButtons = [...buttons].filter((b) => b.textContent === '补齐');
    expect(installButtons).toHaveLength(2);

    await act(async () => {
      installButtons[0].click();
    });

    const forms = container.querySelectorAll('[class*="McpInstallForm"], [class*="border-cafe-accent"]');
    expect(forms).toHaveLength(1);
  });
});
