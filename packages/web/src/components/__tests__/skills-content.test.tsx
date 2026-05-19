import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { threads: unknown[] }) => unknown) => selector({ threads: [] }),
}));

vi.mock('../ThreadSidebar/thread-utils', () => ({
  getProjectPaths: vi.fn(() => []),
  projectDisplayName: (p: string) => p.split('/').pop() ?? p,
}));

import { apiFetch } from '@/utils/api-client';
import { SettingsContent } from '../settings/SettingsContent';
import { SkillsContent } from '../settings/SkillsContent';
import { getProjectPaths } from '../ThreadSidebar/thread-utils';

const mockGetProjectPaths = getProjectPaths as ReturnType<typeof vi.fn>;

const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const skillsPayload = {
  skills: [
    {
      name: 'cross-cat-handoff',
      category: '协作',
      trigger: '交接工作给其他猫',
      mounts: { claude: true, codex: true, gemini: false, kimi: true },
      requiresMcp: [],
    },
    {
      name: 'browser-preview',
      category: '前端',
      trigger: '看页面效果',
      mounts: { claude: true, codex: true, gemini: true, kimi: true },
      requiresMcp: [
        { id: 'playwright', status: 'ready' },
        { id: 'missing-browser', status: 'missing' },
      ],
    },
  ],
  summary: { total: 2, allMounted: false, registrationConsistent: true },
  staleness: {
    stale: true,
    currentHash: 'new',
    recordedHash: 'old',
    newSkills: ['browser-preview'],
    removedSkills: [],
  },
  conflicts: [
    {
      skillName: 'cross-cat-handoff',
      projectTarget: '/repo/cat-cafe-skills/cross-cat-handoff',
      userTarget: '/home/user/cross-cat-handoff',
      activeLayer: 'project',
    },
  ],
};

const capabilitiesPayload = {
  items: [
    {
      id: 'cross-cat-handoff',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      cats: { opus: true, codex: false },
      triggers: ['交接工作给其他猫'],
    },
    {
      id: 'browser-preview',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      cats: { opus: true, codex: true },
      triggers: ['看页面效果'],
    },
  ],
  catFamilies: [{ id: 'ragdoll', name: '布偶猫族', catIds: ['opus', 'codex'] }],
  projectPath: '/path/to/project',
};

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function mockBothApis(skillsOverride?: unknown, capOverride?: unknown) {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/rules/skill/')) {
      return Promise.resolve(
        jsonResponse({
          content: '# browser-preview\n\nLocal preview instructions',
          path: '/repo/cat-cafe-skills/browser-preview/SKILL.md',
        }),
      );
    }
    if (url.startsWith('/api/capabilities')) {
      return Promise.resolve(jsonResponse(capOverride ?? capabilitiesPayload));
    }
    return Promise.resolve(jsonResponse(skillsOverride ?? skillsPayload));
  });
}

describe('SkillsContent', () => {
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
    mockFetch.mockReset();
    mockBothApis();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(element);
    });
    await flushEffects();
  }

  it('fetches both /api/skills and /api/capabilities and renders composed view', async () => {
    await render(React.createElement(SkillsContent));

    const urls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls).toContain('/api/skills');
    expect(urls.some((u: string) => u.startsWith('/api/capabilities'))).toBe(true);

    expect(container.textContent).toContain('Skill 管理');
    expect(container.textContent).toContain('2 skills');
    expect(container.textContent).toContain('cross-cat-handoff');
    expect(container.textContent).toContain('browser-preview');
    expect(container.textContent).toContain('missing-browser:missing');
    expect(container.textContent).toContain('有更新');

    const frontendFilter = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '前端',
    );
    expect(frontendFilter).toBeTruthy();

    await act(async () => {
      frontendFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const skillsList = container.querySelector('[data-testid="skills-list"]');
    expect(skillsList?.textContent).toContain('browser-preview');
    expect(skillsList?.textContent).not.toContain('cross-cat-handoff');
  });

  it('opens a read-only SKILL.md preview from the card', async () => {
    await render(React.createElement(SkillsContent));

    const previewButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('browser-preview'),
    );
    expect(previewButton).toBeTruthy();

    await act(async () => {
      previewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockFetch).toHaveBeenCalledWith('/api/rules/skill/browser-preview');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Local preview instructions');
  });

  it('filters the skill list with the search input', async () => {
    await render(React.createElement(SkillsContent));

    const input = container.querySelector('input[placeholder="筛选 Skill"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'handoff');
    });

    expect(container.textContent).toContain('cross-cat-handoff');
    expect(container.textContent).not.toContain('browser-preview');
  });

  it('renders an empty state when filters match no skills', async () => {
    await render(React.createElement(SkillsContent));

    const input = container.querySelector('input[placeholder="筛选 Skill"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'not-a-skill');
    });

    expect(container.textContent).toContain('暂无匹配的 Skill');
    expect(container.textContent).toContain('调整分类或搜索条件后再试。');
  });

  it('renders /api/skills error in the combined error area', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(jsonResponse(capabilitiesPayload));
      }
      return Promise.resolve(jsonResponse({ error: 'unavailable' }, 503));
    });

    await render(React.createElement(SkillsContent));

    expect(container.textContent).toContain('Skills 数据加载失败 (503)');
  });

  it('wires the settings skills section to the composed SkillsContent surface', async () => {
    await render(React.createElement(SettingsContent, { section: 'skills' }));

    expect(container.textContent).toContain('Skill 管理');
    expect(container.textContent).toContain('browser-preview');
  });

  it('renders global toggle from capability controls', async () => {
    await render(React.createElement(SkillsContent));

    const toggles = container.querySelectorAll('.settings-resource-toggle');
    expect(toggles.length).toBeGreaterThan(0);
  });

  it('governance-only rows render without toggle when no capability match', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(jsonResponse({ items: [], catFamilies: [], projectPath: '/x' }));
      }
      return Promise.resolve(jsonResponse(skillsPayload));
    });

    await render(React.createElement(SkillsContent));

    expect(container.textContent).toContain('cross-cat-handoff');
    expect(container.textContent).toContain('browser-preview');
    const toggles = container.querySelectorAll('.settings-resource-toggle');
    expect(toggles.length).toBe(0);
  });

  it('posts capabilityType skill on global toggle click', async () => {
    await render(React.createElement(SkillsContent));

    const toggles = container.querySelectorAll('.settings-resource-toggle');
    expect(toggles.length).toBeGreaterThan(0);

    await act(async () => {
      (toggles[0] as HTMLButtonElement).click();
    });
    await flushEffects();

    const patchCall = mockFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]) === '/api/capabilities' && (c[1] as { method?: string })?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse((patchCall?.[1] as { body: string }).body);
    expect(body.capabilityType).toBe('skill');
    expect(body.scope).toBe('global');
  });

  it('per-cat toggle posts capabilityType skill with scope cat and catId', async () => {
    await render(React.createElement(SkillsContent));

    // Expand per-cat toggles for the first skill (cross-cat-handoff has cats: {opus: true, codex: false})
    const expandButtons = Array.from(container.querySelectorAll('button[title="按猫开关"]'));
    expect(expandButtons.length).toBeGreaterThan(0);

    await act(async () => {
      (expandButtons[0] as HTMLButtonElement).click();
    });

    // The per-cat section appears within the first card. Find toggles inside it.
    const cards = container.querySelectorAll('.settings-resource-card');
    expect(cards.length).toBeGreaterThan(0);
    const firstCard = cards[0];
    const cardToggles = firstCard.querySelectorAll('.settings-resource-toggle');
    // First card should have: 1 global + 2 per-cat (opus, codex) = 3 toggles
    expect(cardToggles.length).toBe(3);

    // Click the per-cat toggle for codex (3rd toggle, index 2)
    const perCatToggle = cardToggles[2] as HTMLButtonElement;
    mockFetch.mockClear();
    mockBothApis();

    await act(async () => {
      perCatToggle.click();
    });
    await flushEffects();

    const patchCall = mockFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]) === '/api/capabilities' && (c[1] as { method?: string })?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse((patchCall?.[1] as { body: string }).body);
    expect(body.capabilityType).toBe('skill');
    expect(body.scope).toBe('cat');
    expect(body.catId).toBe('codex');
  });

  it('project switch refetches both /api/skills and /api/capabilities with projectPath', async () => {
    const altPath = '/home/user/other-project';
    mockGetProjectPaths.mockReturnValue(['/path/to/project', altPath]);

    await render(React.createElement(SkillsContent));

    // ProjectSelector should be visible since 2 projects
    const projectSelect = container.querySelector('#cap-project-select') as HTMLSelectElement | null;
    expect(projectSelect).toBeTruthy();

    // Clear calls to track new fetches
    mockFetch.mockClear();
    mockBothApis();

    // Switch to alt project
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(projectSelect, altPath);
      projectSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    // Both APIs should be called with projectPath
    const skillsCall = mockFetch.mock.calls.find((c: unknown[]) => String(c[0]).startsWith('/api/skills'));
    const capCall = mockFetch.mock.calls.find((c: unknown[]) => String(c[0]).startsWith('/api/capabilities'));

    expect(skillsCall).toBeTruthy();
    expect(String(skillsCall?.[0])).toContain(`projectPath=${encodeURIComponent(altPath)}`);
    expect(capCall).toBeTruthy();
    expect(String(capCall?.[0])).toContain(`projectPath=${encodeURIComponent(altPath)}`);

    // Reset mock
    mockGetProjectPaths.mockReturnValue([]);
  });
});
