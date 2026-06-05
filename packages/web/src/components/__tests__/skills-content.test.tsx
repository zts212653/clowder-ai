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
  projectPath: '/home/user/cat-cafe',
};

const mountRulesPayload = {
  projectRoot: '/path/to/project',
  rules: {
    version: 1,
    mountPoints: {
      claude: { enabled: true, path: '.claude/skills' },
      codex: { enabled: true, path: '.codex/skills' },
      gemini: { enabled: true, path: '.gemini/skills' },
      kimi: { enabled: true, path: '.kimi/skills' },
    },
    customPaths: [],
  },
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

// F228: backend emits display-ready issues; the frontend renders them verbatim.
const DEFAULT_CONFLICT_ISSUE = {
  skill: 'browser-preview',
  type: 'conflict',
  provider: 'claude',
  message: 'claude 存在同名目录占用（立即同步会覆盖和清理已有内容，请先确认是否需要进行备份）',
};

function driftResponse(projectRoot: string | undefined, issues: unknown[] = [], isIgnored = false): Response {
  return jsonResponse({ result: { issues, driftHash: `hash:${projectRoot ?? 'global'}`, isIgnored }, projectRoot });
}

/** Default drift routing: an anomaly in the global scope, projects clean. */
function defaultDriftIssues(projectPath?: string): unknown[] {
  return projectPath ? [] : [DEFAULT_CONFLICT_ISSUE];
}

function mockBothApis(
  skillsOverride?: unknown,
  capOverride?: unknown,
  driftIssuesFor: (projectPath?: string) => unknown[] = defaultDriftIssues,
) {
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
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
    if (url === '/api/skills/drift-check') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { projectPath?: string };
      return Promise.resolve(driftResponse(body.projectPath, driftIssuesFor(body.projectPath)));
    }
    if (url === '/api/skills/drift-resolve' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true }));
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
    expect(container.textContent).toContain('检测到 1 处 Skill 异常');
    expect(container.textContent).toContain('查看详情');

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
    // SkillPreviewModal uses createPortal(... , document.body)
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Local preview instructions');
  });

  it('filters the skill list with the search input', async () => {
    await render(React.createElement(SkillsContent));

    const input = container.querySelector('input[placeholder="筛选 Skill"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'handoff');
    });

    const skillsList = container.querySelector('[data-testid="skills-list"]');
    expect(skillsList?.textContent).toContain('cross-cat-handoff');
    expect(skillsList?.textContent).not.toContain('browser-preview');
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

  // Note: 'wires settings skills section' test moved out — it depends on
  // SettingsContent which has a deep transitive import chain needing separate mocks.

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

  it('refetches all-scope skill data after global skill toggles with a retained project selection', async () => {
    const altPath = '/home/user/other-project';
    mockGetProjectPaths.mockReturnValue(['/home/user/cat-cafe', altPath]);

    await render(React.createElement(SkillsContent));

    const projectScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('项目 Skill'),
    );
    expect(projectScopeTab).toBeTruthy();

    await act(async () => {
      projectScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const projectSelect = container.querySelector('#cap-project-select') as HTMLSelectElement | null;
    expect(projectSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(projectSelect, altPath);
      projectSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const allScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('全部 Skill'),
    );
    expect(allScopeTab).toBeTruthy();

    await act(async () => {
      allScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    mockFetch.mockClear();
    mockBothApis();

    const toggle = container.querySelector('.settings-resource-toggle') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle?.click();
    });
    await flushEffects();

    const patchIndex = mockFetch.mock.calls.findIndex(
      (call: unknown[]) =>
        String(call[0]) === '/api/capabilities' && (call[1] as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    const patchBody = JSON.parse(String((mockFetch.mock.calls[patchIndex]?.[1] as { body?: string })?.body ?? '{}'));
    expect(patchBody).toMatchObject({ scope: 'global' });
    expect(patchBody.projectPath).toBeUndefined();
    const refetchUrls = mockFetch.mock.calls.slice(patchIndex + 1).map((call: unknown[]) => String(call[0]));
    expect(refetchUrls).toContain('/api/capabilities');
    expect(refetchUrls).toContain('/api/skills');
    expect(refetchUrls).not.toContain(`/api/capabilities?projectPath=${encodeURIComponent(altPath)}`);
    expect(refetchUrls).not.toContain(`/api/skills?projectPath=${encodeURIComponent(altPath)}`);

    mockGetProjectPaths.mockReturnValue([]);
  });

  it('refetches all-scope skill data after default mount rules save with a retained project selection', async () => {
    const mainPath = '/home/user/cat-cafe';
    const altPath = '/home/user/other-project';
    mockGetProjectPaths.mockReturnValue([mainPath, altPath]);
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(
          jsonResponse({ ...capabilitiesPayload, projectPath: mainPath, knownProjectPaths: [mainPath, altPath] }),
        );
      }
      if (url.startsWith('/api/mount-rules') && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.startsWith('/api/mount-rules')) {
        return Promise.resolve(jsonResponse(mountRulesPayload));
      }
      return Promise.resolve(jsonResponse(skillsPayload));
    });

    await render(React.createElement(SkillsContent));

    const projectScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('项目 Skill'),
    );
    expect(projectScopeTab).toBeTruthy();

    await act(async () => {
      projectScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const projectSelect = container.querySelector('#cap-project-select') as HTMLSelectElement | null;
    expect(projectSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(projectSelect, altPath);
      projectSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const allScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('全部 Skill'),
    );
    expect(allScopeTab).toBeTruthy();

    await act(async () => {
      allScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const mountRulesButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('全局默认 Mount Rules'),
    );
    expect(mountRulesButton).toBeTruthy();

    await act(async () => {
      mountRulesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    mockFetch.mockClear();

    const claudeToggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(claudeToggle).toBeTruthy();

    await act(async () => {
      claudeToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    const putIndex = mockFetch.mock.calls.findIndex(
      (call: unknown[]) => String(call[0]) === '/api/mount-rules' && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(putIndex).toBeGreaterThanOrEqual(0);
    const putBody = JSON.parse(String((mockFetch.mock.calls[putIndex]?.[1] as { body?: string })?.body ?? '{}'));
    expect(putBody).toMatchObject({ scope: 'default' });
    expect(putBody.projectPath).toBeUndefined();

    const refetchUrls = mockFetch.mock.calls.slice(putIndex + 1).map((call: unknown[]) => String(call[0]));
    expect(refetchUrls).toContain('/api/capabilities');
    expect(refetchUrls).toContain('/api/skills');
    expect(refetchUrls).not.toContain(`/api/capabilities?projectPath=${encodeURIComponent(altPath)}`);
    expect(refetchUrls).not.toContain(`/api/skills?projectPath=${encodeURIComponent(altPath)}`);

    mockGetProjectPaths.mockReturnValue([]);
  });

  it('renders plugin-owned skills with same controls as regular skills', async () => {
    mockBothApis(undefined, {
      ...capabilitiesPayload,
      items: capabilitiesPayload.items.map((item) =>
        item.id === 'browser-preview' ? { ...item, pluginId: 'preview-plugin' } : item,
      ),
    });

    await render(React.createElement(SkillsContent));

    const cards = Array.from(container.querySelectorAll('.settings-resource-card'));
    const pluginCard = cards.find((card) => card.textContent?.includes('browser-preview'));
    expect(pluginCard).toBeTruthy();

    // Plugin skill has same toggle as regular skills — not disabled
    const pluginToggle = pluginCard?.querySelector('.settings-resource-toggle') as HTMLButtonElement | null;
    expect(pluginToggle).toBeTruthy();
    expect(pluginToggle?.disabled).not.toBe(true);

    // Clicking toggle fires the same PATCH as regular skills
    mockFetch.mockClear();
    mockBothApis();

    await act(async () => {
      pluginToggle?.click();
    });
    await flushEffects();

    expect(
      mockFetch.mock.calls.some(
        (c: unknown[]) => String(c[0]) === '/api/capabilities' && (c[1] as { method?: string })?.method === 'PATCH',
      ),
    ).toBe(true);

    // Preview click works — fires skill preview fetch
    mockFetch.mockClear();
    mockBothApis();

    const previewButton = Array.from(pluginCard?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('browser-preview'),
    ) as HTMLButtonElement | undefined;
    expect(previewButton?.disabled).not.toBe(true);

    await act(async () => {
      previewButton?.click();
    });
    await flushEffects();

    expect(mockFetch.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('/api/rules/skill/'))).toBe(true);
  });

  it('per-provider toggle posts capabilityType skill with mountPointId and scope', async () => {
    await render(React.createElement(SkillsContent));

    const expandButtons = Array.from(container.querySelectorAll('button[title="按挂载规则"]'));
    expect(expandButtons.length).toBeGreaterThan(0);

    await act(async () => {
      (expandButtons[0] as HTMLButtonElement).click();
    });
    await flushEffects();

    mockFetch.mockClear();
    mockBothApis();

    const providerToggle = container.querySelector('button[aria-label="启用 gemini 挂载"]') as HTMLButtonElement | null;
    expect(providerToggle).toBeTruthy();

    await act(async () => {
      providerToggle?.click();
    });
    await flushEffects();

    const patchCall = mockFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]) === '/api/capabilities' && (c[1] as { method?: string })?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse((patchCall?.[1] as { body: string }).body);
    expect(body.capabilityType).toBe('skill');
    expect(body.scope).toBe('global');
    expect(body.mountPointId).toBe('gemini');
  });

  it('project switch is only available inside the "项目 Skill" tab', async () => {
    const altPath = '/home/user/other-project';
    mockGetProjectPaths.mockReturnValue(['/home/user/cat-cafe', altPath]);

    await render(React.createElement(SkillsContent));

    expect(container.querySelector('#cap-project-select')).toBeNull();

    const projectScopeTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    expect(projectScopeTab).toBeTruthy();

    await act(async () => {
      projectScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // ProjectSelector should be visible since 2 projects, but only in project scope.
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

  it('scope tabs default to "全部 Skill" as an all-project sync surface', async () => {
    await render(React.createElement(SkillsContent));

    const scopeTabs = container.querySelector('[data-testid="skills-scope-tabs"]');
    expect(scopeTabs?.textContent).toContain('全部 Skill');
    expect(scopeTabs?.textContent).toContain('项目 Skill');
    expect(container.textContent).toContain('检测到 1 处 Skill 异常');
    expect(container.textContent).toContain('查看详情');

    const skillsList = container.querySelector('[data-testid="skills-list"]');
    expect(skillsList?.textContent).toContain('cross-cat-handoff');
    expect(skillsList?.textContent).toContain('browser-preview');
    expect(skillsList?.textContent).not.toContain('全部挂载');
    expect(skillsList?.textContent).toMatch(/全部项目一致|部分项目一致|待同步/);
    expect(container.textContent).not.toContain('部分挂载缺失');
  });

  it('refreshes selected project data when switching from "全部 Skill" to "项目 Skill"', async () => {
    await render(React.createElement(SkillsContent));
    await flushEffects();

    mockFetch.mockClear();
    mockBothApis();

    const projectTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    expect(projectTab).toBeTruthy();

    await act(async () => {
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const projectPath = '/home/user/cat-cafe';
    const urls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls).toContain(`/api/skills?projectPath=${encodeURIComponent(projectPath)}`);
    expect(urls).toContain(`/api/capabilities?projectPath=${encodeURIComponent(projectPath)}`);
  });

  it('"项目 Skill" tab shows the full skill list (回显完整) including policy-disabled skills', async () => {
    const mixedPayload = {
      ...skillsPayload,
      skills: [
        ...skillsPayload.skills,
        {
          name: 'policy-unmounted-skill',
          source: 'cat-cafe',
          category: '工具',
          trigger: '/policy-unmounted',
          mountPaths: [],
          mounts: { claude: false, codex: false, gemini: false, kimi: false },
          mountHealth: {
            enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
            mountedCount: 0,
            requiredCount: 0,
            allMounted: true,
          },
          requiresMcp: [],
        },
        {
          name: 'missing-mounted-skill',
          source: 'cat-cafe',
          category: '工具',
          trigger: '/missing-mounted',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
          mounts: { claude: false, codex: false, gemini: false, kimi: false },
          mountHealth: {
            enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
            mountedCount: 0,
            requiredCount: 4,
            allMounted: false,
          },
          requiresMcp: [],
        },
        {
          name: 'external-local-skill',
          source: 'external',
          category: '本地',
          trigger: '/external-local',
          mountPaths: [],
          mounts: { claude: false, codex: false, gemini: false, kimi: false },
          mountHealth: {
            enabledMountPoints: [],
            mountedCount: 0,
            requiredCount: 0,
            allMounted: true,
          },
          requiresMcp: [],
        },
      ],
      summary: { total: 5, allMounted: false, registrationConsistent: true },
    };
    mockFetch.mockClear();
    mockBothApis(mixedPayload, {
      ...capabilitiesPayload,
      items: [
        ...capabilitiesPayload.items,
        {
          id: 'policy-unmounted-skill',
          type: 'skill',
          source: 'cat-cafe',
          enabled: false,
          mountPaths: [],
          cats: { opus: false, codex: false },
          triggers: ['/policy-unmounted'],
        },
        {
          id: 'missing-mounted-skill',
          type: 'skill',
          source: 'cat-cafe',
          enabled: true,
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
          cats: { opus: true, codex: true },
          triggers: ['/missing-mounted'],
        },
        {
          id: 'external-local-skill',
          type: 'skill',
          source: 'external',
          enabled: true,
          mountPaths: [],
          cats: { opus: true, codex: true },
          triggers: ['/external-local'],
        },
      ],
    });

    await render(React.createElement(SkillsContent));

    const projectTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    expect(projectTab).toBeTruthy();

    await act(async () => {
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const skillsList = container.querySelector('[data-testid="skills-list"]');
    // F228: project scope now 回显完整 — policy-disabled skills are shown too.
    expect(skillsList?.textContent).toContain('policy-unmounted-skill');
    expect(skillsList?.textContent).toContain('missing-mounted-skill');
    expect(skillsList?.textContent).toContain('0/4 已挂载');
    expect(skillsList?.textContent).toContain('external-local-skill');
    expect(skillsList?.textContent).toContain('cross-cat-handoff');
    expect(skillsList?.textContent).toContain('browser-preview');
  });

  it('"全部 Skill" can sync every known project', async () => {
    const projectA = '/workspace/project-a';
    const projectB = '/workspace/project-b';
    mockGetProjectPaths.mockReturnValue([projectA, projectB]);
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/rules/skill/')) {
        return Promise.resolve(jsonResponse({ content: '# skill', path: '/repo/cat-cafe-skills/skill/SKILL.md' }));
      }
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(jsonResponse({ ...capabilitiesPayload, projectPath: projectA }));
      }
      if (url === '/api/skills/drift-check') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { projectPath?: string };
        // Global scope has an anomaly so the banner + dialog render.
        return Promise.resolve(driftResponse(body.projectPath, body.projectPath ? [] : [DEFAULT_CONFLICT_ISSUE]));
      }
      if (url === '/api/skills/drift-resolve' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(skillsPayload));
    });

    await render(React.createElement(SkillsContent));
    await flushEffects();

    const syncAll = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情')) as
      | HTMLButtonElement
      | undefined;
    expect(syncAll).toBeTruthy();

    await act(async () => {
      syncAll?.click();
    });
    await flushEffects();

    const syncAllInDialog = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('同步全部'),
    ) as HTMLButtonElement | undefined;
    expect(syncAllInDialog).toBeTruthy();

    mockFetch.mockClear();
    await act(async () => {
      syncAllInDialog?.click();
    });
    await flushEffects();

    // F228: sync-all resolves global + every project scope via drift-resolve.
    const syncCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]) === '/api/skills/drift-resolve' && (c[1] as { method?: string })?.method === 'POST',
    );
    const bodies = syncCalls.map((c) => JSON.parse((c[1] as { body: string }).body));
    expect(bodies.every((b) => b.action === 'sync')).toBe(true);
    const projectBodies = bodies
      .map((b) => b.projectPath)
      .filter(Boolean)
      .sort();
    expect(projectBodies).toEqual([projectA, projectB].sort());
    // Plus one global scope resolve (no projectPath).
    expect(bodies.some((b) => !b.projectPath)).toBe(true);

    mockGetProjectPaths.mockReturnValue([]);
  });

  it('"全部 Skill" refetches all-scope data after sync-all with a retained project selection', async () => {
    const projectA = '/workspace/project-a';
    const projectB = '/workspace/project-b';
    mockGetProjectPaths.mockReturnValue([projectA, projectB]);
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/rules/skill/')) {
        return Promise.resolve(jsonResponse({ content: '# skill', path: '/repo/cat-cafe-skills/skill/SKILL.md' }));
      }
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(
          jsonResponse({ ...capabilitiesPayload, projectPath: projectA, knownProjectPaths: [projectA, projectB] }),
        );
      }
      if (url === '/api/skills/drift-check') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { projectPath?: string };
        // Global scope anomaly so the all-skills banner renders.
        return Promise.resolve(driftResponse(body.projectPath, body.projectPath ? [] : [DEFAULT_CONFLICT_ISSUE]));
      }
      if (url === '/api/skills/drift-resolve' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse(skillsPayload));
    });

    await render(React.createElement(SkillsContent));
    await flushEffects();

    const projectScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('项目 Skill'),
    );
    expect(projectScopeTab).toBeTruthy();

    await act(async () => {
      projectScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const projectSelect = container.querySelector('#cap-project-select') as HTMLSelectElement | null;
    expect(projectSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(projectSelect, projectB);
      projectSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const allScopeTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('全部 Skill'),
    );
    expect(allScopeTab).toBeTruthy();

    await act(async () => {
      allScopeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const syncAll = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情')) as
      | HTMLButtonElement
      | undefined;
    expect(syncAll).toBeTruthy();

    await act(async () => {
      syncAll?.click();
    });
    await flushEffects();

    const syncAllInDialog = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('同步全部'),
    ) as HTMLButtonElement | undefined;
    expect(syncAllInDialog).toBeTruthy();

    mockFetch.mockClear();
    await act(async () => {
      syncAllInDialog?.click();
    });
    await flushEffects();

    const postSyncUrls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(postSyncUrls).toContain('/api/skills');
    expect(postSyncUrls).toContain('/api/capabilities');

    mockGetProjectPaths.mockReturnValue([]);
  });

  it('"全部 Skill" aggregates per-project drift-check anomalies', async () => {
    const projectA = '/workspace/project-a';
    const projectB = '/workspace/project-b';
    const healthySkillsPayload = {
      ...skillsPayload,
      summary: { total: 2, allMounted: true, registrationConsistent: true },
      staleness: {
        stale: false,
        currentHash: 'same',
        recordedHash: 'same',
        newSkills: [],
        removedSkills: [],
      },
    };
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/threads') {
        return Promise.resolve(jsonResponse({ threads: [] }));
      }
      if (url.startsWith('/api/rules/skill/')) {
        return Promise.resolve(jsonResponse({ content: '# skill', path: '/repo/cat-cafe-skills/skill/SKILL.md' }));
      }
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(
          jsonResponse({ ...capabilitiesPayload, projectPath: projectA, knownProjectPaths: [projectA, projectB] }),
        );
      }
      if (url === '/api/skills/drift-check') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { projectPath?: string };
        return Promise.resolve(
          driftResponse(
            body.projectPath,
            body.projectPath === projectB
              ? [
                  {
                    skill: 'browser-preview',
                    type: 'conflict',
                    provider: 'claude',
                    message: 'claude 存在同名目录占用（立即同步会覆盖和清理已有内容，请先确认是否需要进行备份）',
                  },
                ]
              : [],
          ),
        );
      }
      if (url.startsWith('/api/skills')) {
        return Promise.resolve(jsonResponse(healthySkillsPayload));
      }
      return Promise.resolve(jsonResponse({}));
    });

    await render(React.createElement(SkillsContent));
    await flushEffects();
    await flushEffects();

    // F228: all-skills fetches the global scope plus every project scope.
    const driftScopes = new Set(
      mockFetch.mock.calls
        .filter((call: unknown[]) => String(call[0]) === '/api/skills/drift-check')
        .map((call) => JSON.parse(String((call[1] as { body?: string })?.body ?? '{}')).projectPath ?? 'global'),
    );
    expect(driftScopes.has('global')).toBe(true);
    expect(driftScopes.has(projectA)).toBe(true);
    expect(driftScopes.has(projectB)).toBe(true);
    expect(container.textContent).toContain('检测到 1 处 Skill 异常');

    const detail = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情'));
    await act(async () => {
      detail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('项目 Skill 异常详情');
    expect(String(dialog?.className)).toContain('fixed');
    expect(String(dialog?.className)).toContain('inset-0');
    // Only project-b scope (with the conflict) appears, showing the verbatim backend message.
    expect(dialog?.textContent).toContain('project-b');
    expect(dialog?.textContent).toContain('browser-preview');
    expect(dialog?.textContent).toContain('存在同名目录占用');
    expect(dialog?.textContent).not.toContain('project-a');
    expect(container.textContent).not.toContain('全部 Skill 同步一致');
    // Scope label has no stray '/' prefix.
    expect(dialog?.textContent).not.toContain('/project-b');

    // Scope is collapsible: clicking the scope header folds its issues away.
    const scopeToggle = Array.from(dialog?.querySelectorAll('button[aria-expanded]') ?? []).find((b) =>
      b.textContent?.includes('project-b'),
    );
    expect(scopeToggle).toBeTruthy();
    expect(scopeToggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      scopeToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const collapsedToggle = Array.from(dialog?.querySelectorAll('button[aria-expanded]') ?? []).find((b) =>
      b.textContent?.includes('project-b'),
    );
    expect(collapsedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(dialog?.textContent).not.toContain('存在同名目录占用');
  });

  it('opens one unified issue dialog rendering backend project issues verbatim', async () => {
    // F228: project-scope anomalies come from the backend drift-check `issues`
    // (config-sync + mount), rendered per-skill. No client-side recomputation.
    const projectIssues = [
      { skill: 'new-local-skill', type: 'config-orphan', message: '本项目残留，全局已移除' },
      { skill: 'browser-preview', type: 'mount-missing', provider: 'codex', message: 'codex 未挂载' },
    ];
    mockBothApis(undefined, undefined, (projectPath?: string) => (projectPath ? projectIssues : []));
    await render(React.createElement(SkillsContent));

    const projectTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    await act(async () => {
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const issueButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查看详情'),
    );
    expect(issueButton).toBeTruthy();
    expect(container.textContent).toContain('检测到');
    expect(container.textContent).toContain('项 Skill 异常');
    // Banner stays compact: action buttons live inside the dialog only.
    expect(container.textContent).not.toContain('立即同步');
    expect(container.textContent).not.toContain('忽略本次');

    await act(async () => {
      issueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Skill 异常详情');
    expect(String(dialog?.className)).toContain('fixed');
    expect(String(dialog?.className)).toContain('inset-0');
    expect(dialog?.textContent).toContain('立即同步');
    // F228: "忽略本次" removed — no managed ignore state, so the button is gone.
    expect(dialog?.textContent).not.toContain('忽略本次');
    // Per-skill issues rendered verbatim from the backend message.
    expect(dialog?.textContent).toContain('new-local-skill');
    expect(dialog?.textContent).toContain('本项目残留，全局已移除');
    expect(dialog?.textContent).toContain('browser-preview');
    expect(dialog?.textContent).toContain('codex 未挂载');
    const close = dialog?.querySelector('button[aria-label="关闭"]');
    expect(close?.textContent).toContain('×');

    // F228 UX #1: clicking the backdrop dismisses the dialog.
    await act(async () => {
      dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('refreshes project skills and drift state after saving mount rules', async () => {
    const selectedProjectPath = '/path/to/project';
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/capabilities')) {
        return Promise.resolve(jsonResponse({ ...capabilitiesPayload, projectPath: selectedProjectPath }));
      }
      if (url === '/api/skills/drift-check') {
        return Promise.resolve(
          jsonResponse({
            result: { issues: [], driftHash: 'fresh-after-mount-rules', isIgnored: false },
            projectRoot: '/path/to/project',
          }),
        );
      }
      if (url.startsWith('/api/mount-rules') && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.startsWith('/api/mount-rules')) {
        return Promise.resolve(jsonResponse(mountRulesPayload));
      }
      return Promise.resolve(jsonResponse(skillsPayload));
    });

    await render(React.createElement(SkillsContent));

    const projectTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    expect(projectTab).toBeTruthy();

    await act(async () => {
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const mountRulesButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Mount Rules'),
    );
    expect(mountRulesButton).toBeTruthy();

    await act(async () => {
      mountRulesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    mockFetch.mockClear();

    const claudeToggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(claudeToggle).toBeTruthy();

    await act(async () => {
      claudeToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    const urls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      mockFetch.mock.calls.some(
        (call: unknown[]) =>
          String(call[0]) === '/api/mount-rules' && (call[1] as { method?: string })?.method === 'PUT',
      ),
    ).toBe(true);
    expect(urls).toContain(`/api/skills?projectPath=${encodeURIComponent(selectedProjectPath)}`);
    expect(urls).toContain(`/api/capabilities?projectPath=${encodeURIComponent(selectedProjectPath)}`);

    const driftRefresh = mockFetch.mock.calls.find((call: unknown[]) => String(call[0]) === '/api/skills/drift-check');
    expect(driftRefresh).toBeTruthy();
    expect(JSON.parse(String((driftRefresh?.[1] as { body?: string })?.body ?? '{}'))).toMatchObject({
      projectPath: selectedProjectPath,
    });
  });

  it('lets custom mount rules use the same per-skill toggle flow as standard providers', async () => {
    const skillsWithCustomMount = {
      ...skillsPayload,
      skills: skillsPayload.skills.map((skill) =>
        skill.name === 'cross-cat-handoff'
          ? {
              ...skill,
              mounts: { ...skill.mounts, test: false },
              mountHealth: {
                enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi', 'test'],
                mountedCount: 3,
                requiredCount: 5,
                allMounted: false,
              },
            }
          : skill,
      ),
    };
    mockBothApis(skillsWithCustomMount);

    await render(React.createElement(SkillsContent));

    const projectTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('项目 Skill'),
    );
    expect(projectTab).toBeTruthy();

    await act(async () => {
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const mountButtons = Array.from(container.querySelectorAll('button[title="按挂载规则"]'));
    expect(mountButtons.length).toBeGreaterThan(0);

    await act(async () => {
      mountButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('test');
    expect(container.textContent).toContain('自定义路径');
    expect(container.textContent).not.toContain('由 Mount Rules 管理');

    mockFetch.mockClear();
    const customToggle = container.querySelector('button[aria-label="启用 test 挂载"]');
    expect(customToggle).toBeTruthy();

    await act(async () => {
      customToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    const patchCall = mockFetch.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]) === '/api/capabilities' && (call[1] as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String((patchCall?.[1] as { body?: string })?.body ?? '{}'))).toMatchObject({
      capabilityId: 'cross-cat-handoff',
      capabilityType: 'skill',
      scope: 'project',
      mountPointId: 'test',
      enabled: true,
    });
  });
});
