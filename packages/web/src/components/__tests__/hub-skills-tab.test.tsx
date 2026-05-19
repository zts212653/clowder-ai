import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubSkillsTab } from '@/components/HubSkillsTab';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('HubSkillsTab', () => {
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
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders provider columns including Kimi and its mount badge', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        skills: [
          {
            name: 'cross-cat-handoff',
            category: '协作',
            trigger: '@handoff',
            mounts: { claude: true, codex: true, gemini: false, kimi: true },
          },
        ],
        summary: {
          total: 1,
          allMounted: false,
          registrationConsistent: true,
        },
        staleness: null,
        conflicts: [],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubSkillsTab));
    });
    await flushEffects();

    const text = container.textContent ?? '';
    expect(text).toContain('Claude');
    expect(text).toContain('Codex');
    expect(text).toContain('Gemini');
    expect(text).toContain('Kimi');
    expect(text).toContain('cross-cat-handoff');
    expect(text).toContain('部分挂载缺失');

    const badges = [...container.querySelectorAll('svg')].filter((node) =>
      node.querySelector('path[d="M20 6L9 17l-5-5"]'),
    );
    expect(badges).toHaveLength(3);
  });

  it('opens a read-only SKILL.md preview from the skill name', async () => {
    mockApiFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/rules/skill/')) {
        return Promise.resolve(
          jsonResponse({
            content: '# cross-cat-handoff\n\nHandoff instructions',
            path: '/repo/cat-cafe-skills/cross-cat-handoff/SKILL.md',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          skills: [
            {
              name: 'cross-cat-handoff',
              category: '协作',
              trigger: '@handoff',
              mounts: { claude: true, codex: true, gemini: true, kimi: true },
            },
          ],
          summary: {
            total: 1,
            allMounted: true,
            registrationConsistent: true,
          },
          staleness: null,
          conflicts: [],
        }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HubSkillsTab));
    });
    await flushEffects();

    const previewButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'cross-cat-handoff',
    );
    expect(previewButton).toBeTruthy();

    await act(async () => {
      previewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/rules/skill/cross-cat-handoff');
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('协作');
    expect(container.textContent).toContain('Handoff instructions');
    expect(container.textContent).toContain('/repo/cat-cafe-skills/cross-cat-handoff/SKILL.md');
  });
});
