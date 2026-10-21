import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSelector } from '../../settings/capability-settings-ui';
import { PROJECT_NAME_KEY } from '../active-workspace';
import { ProjectOption } from '../ProjectOption';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const PATH_A = String.raw`C:\team-a\demo`;
const PATH_B = String.raw`D:\team-b\demo`;
const paths = [PATH_A, PATH_B];

describe('Windows project display preserves project identity (#1585)', () => {
  let harness: ThreadSidebarHarness;
  const setCurrentProject = vi.fn();

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    setCurrentProject.mockReset();
    localStorage.setItem('cat-cafe:sidebar:active-tab', 'project');
    Object.assign(mockStore, {
      threads: paths.map((projectPath, index) => ({
        id: `project-${index}`,
        title: `Conversation ${index}`,
        projectPath,
        createdBy: 'user',
        participants: [],
        lastActiveAt: Date.now() - index,
        createdAt: Date.now(),
      })),
      currentThreadId: 'default',
      threadStates: {},
      isLoadingThreads: false,
      setCurrentProject,
    });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk({ id: 'created' });
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  function projectHeading(path: string) {
    const buttons = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button[data-project-path]'));
    const button = buttons.find((btn) => btn.getAttribute('data-project-path') === path);
    if (!button) throw new Error(`Project heading missing: ${path}`);
    return button;
  }

  it('keeps two same-name projects separate and creates in each original path', async () => {
    await harness.render();
    expect(projectHeading(PATH_A).textContent).toBe('demo');
    expect(projectHeading(PATH_B).textContent).toBe('demo');

    const createButtons = harness.container.querySelectorAll<HTMLButtonElement>('[data-testid="quick-create-btn"]');
    expect(createButtons).toHaveLength(2);
    for (const button of createButtons) {
      await act(async () => button.click());
      await harness.flush();
    }

    const creates = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/threads' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(creates.map(([, init]) => JSON.parse((init as RequestInit).body as string))).toEqual(
      paths.map((projectPath) => ({ projectPath })),
    );
    expect(setCurrentProject.mock.calls.map(([path]) => path)).toEqual(paths);
  });

  it('keeps custom project names ahead of generated labels across remounts', async () => {
    localStorage.setItem(PROJECT_NAME_KEY, JSON.stringify({ [PATH_A]: '我的项目' }));
    await harness.render();
    expect(projectHeading(PATH_A).textContent).toBe('我的项目');
    expect(projectHeading(PATH_B).textContent).toBe('demo');

    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    expect(projectHeading(PATH_A).textContent).toBe('我的项目');
    expect(localStorage.getItem(PROJECT_NAME_KEY)).toBe(JSON.stringify({ [PATH_A]: '我的项目' }));
  });

  it('uses short names in the creation picker while selecting the full original path', async () => {
    const select = vi.fn();
    await act(async () => {
      harness.root.render(
        paths.map((path) => <ProjectOption key={path} path={path} selected={false} onSelect={() => select(path)} />),
      );
    });

    const buttons = harness.container.querySelectorAll<HTMLButtonElement>('[data-project-path]');
    expect(buttons).toHaveLength(2);
    for (const [index, button] of Array.from(buttons).entries()) {
      expect(button.getAttribute('aria-label')).toBe(`选择项目 demo，路径 ${paths[index]}`);
      await act(async () => button.click());
    }
    expect(select.mock.calls.map(([path]) => path)).toEqual(paths);
  });

  it('keeps full option values when settings show two short, identical names', async () => {
    const onSwitch = vi.fn();
    await act(async () => {
      harness.root.render(
        <ProjectSelector
          resolvedPath="/workspace"
          knownProjects={paths}
          currentSelection={PATH_A}
          onSwitch={onSwitch}
        />,
      );
    });
    const select = harness.container.querySelector<HTMLSelectElement>('#cap-project-select');
    if (!select) throw new Error('Settings project selector missing');
    expect(Array.from(select.options).map((option) => option.text)).toEqual(['demo', 'demo']);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(paths);
    await act(async () => {
      select.value = PATH_B;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSwitch).toHaveBeenCalledWith(PATH_B);
  });
});
