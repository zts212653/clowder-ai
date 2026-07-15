/**
 * F113 Phase D: DirectoryBrowser component tests.
 * Covers breadcrumb navigation, directory listing, path input,
 * and cross-platform path separator handling.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryBrowser } from '../DirectoryBrowser';

// ── Mock apiFetch ──────────────────────────────────────────────
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// ── Helpers ────────────────────────────────────────────────────
function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}
function jsonFail(status = 500, error = 'fail') {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });
}

const HOME = '/home/user';

function makeBrowseResult(current: string, entries: { name: string; path: string }[], parent: string | null = HOME) {
  return {
    current,
    name: current.split('/').pop() || '',
    parent,
    homePath: HOME,
    entries: entries.map((e) => ({ ...e, isDirectory: true })),
  };
}

describe('DirectoryBrowser', () => {
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
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(props: Partial<React.ComponentProps<typeof DirectoryBrowser>> = {}) {
    const defaults = {
      onCurrentPathChange: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    };
    act(() => {
      root.render(React.createElement(DirectoryBrowser, defaults));
    });
    return defaults;
  }

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function getAllButtons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('button'));
  }

  function findButtonByText(text: string): HTMLButtonElement | undefined {
    return getAllButtons().find((b) => b.textContent?.includes(text));
  }

  // ── Initial load ─────────────────────────────────────────

  it('fetches home directory on mount and shows entries', async () => {
    mockApiFetch.mockReturnValue(
      jsonOk(
        makeBrowseResult(
          HOME,
          [
            { name: 'projects', path: `${HOME}/projects` },
            { name: 'Documents', path: `${HOME}/Documents` },
          ],
          null,
        ),
      ),
    );
    render();
    await flush();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/browse');
    expect(container.textContent).toContain('projects');
    expect(container.textContent).toContain('Documents');
    expect(container.textContent).toContain('Home');
  });

  // ── Directory drilling ──────────────────────────────────

  it('navigates into a subdirectory when clicking a folder row', async () => {
    // Initial: home
    mockApiFetch.mockReturnValueOnce(
      jsonOk(makeBrowseResult(HOME, [{ name: 'projects', path: `${HOME}/projects` }], null)),
    );
    render();
    await flush();

    // Click "projects" folder
    mockApiFetch.mockReturnValueOnce(
      jsonOk(
        makeBrowseResult(`${HOME}/projects`, [
          { name: 'cat-cafe', path: `${HOME}/projects/cat-cafe` },
          { name: 'other', path: `${HOME}/projects/other` },
        ]),
      ),
    );
    const projectsBtn = findButtonByText('projects');
    expect(projectsBtn).toBeTruthy();
    await act(async () => {
      projectsBtn!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockApiFetch).toHaveBeenCalledWith(`/api/projects/browse?path=${encodeURIComponent(`${HOME}/projects`)}`);
    expect(container.textContent).toContain('cat-cafe');
    expect(container.textContent).toContain('other');
  });

  // ── Breadcrumb navigation ──────────────────────────────

  it('shows breadcrumb segments and navigates back when clicking a segment', async () => {
    // Start at a deep path
    mockApiFetch.mockReturnValueOnce(
      jsonOk(
        makeBrowseResult(`${HOME}/projects/cat-cafe`, [
          { name: 'packages', path: `${HOME}/projects/cat-cafe/packages` },
        ]),
      ),
    );
    render({ initialPath: `${HOME}/projects/cat-cafe` });
    await flush();

    // Should show breadcrumb: Home > projects > cat-cafe
    expect(container.textContent).toContain('Home');
    expect(container.textContent).toContain('projects');
    expect(container.textContent).toContain('cat-cafe');

    // Click "Home" breadcrumb to go back to home
    mockApiFetch.mockReturnValueOnce(
      jsonOk(
        makeBrowseResult(
          HOME,
          [
            { name: 'projects', path: `${HOME}/projects` },
            { name: 'Desktop', path: `${HOME}/Desktop` },
          ],
          null,
        ),
      ),
    );
    const homeBtn = findButtonByText('Home');
    expect(homeBtn).toBeTruthy();
    await act(async () => {
      homeBtn!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Home breadcrumb calls browse without path (defaults to home)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/browse');
    expect(container.textContent).toContain('Desktop');
  });

  it('clicking mid-level breadcrumb navigates to that level', async () => {
    mockApiFetch.mockReturnValueOnce(
      jsonOk(
        makeBrowseResult(`${HOME}/projects/cat-cafe`, [
          { name: 'packages', path: `${HOME}/projects/cat-cafe/packages` },
        ]),
      ),
    );
    render({ initialPath: `${HOME}/projects/cat-cafe` });
    await flush();

    // Click "projects" breadcrumb (mid-level)
    mockApiFetch.mockReturnValueOnce(
      jsonOk(makeBrowseResult(`${HOME}/projects`, [{ name: 'cat-cafe', path: `${HOME}/projects/cat-cafe` }])),
    );
    const projectsBtn = findButtonByText('projects');
    expect(projectsBtn).toBeTruthy();
    await act(async () => {
      projectsBtn!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockApiFetch).toHaveBeenCalledWith(`/api/projects/browse?path=${encodeURIComponent(`${HOME}/projects`)}`);
  });

  // ── Current path and cancel ────────────────────────────

  it('calls onCurrentPathChange when the current path loads', async () => {
    mockApiFetch.mockReturnValueOnce(jsonOk(makeBrowseResult(`${HOME}/projects`, [], HOME)));
    const fns = render({ initialPath: `${HOME}/projects` });
    await flush();

    expect(fns.onCurrentPathChange).toHaveBeenCalledWith(`${HOME}/projects`);
    expect(findButtonByText('选择此目录')).toBeFalsy();
  });

  it('calls onCancel when "收起浏览" is clicked', async () => {
    mockApiFetch.mockReturnValueOnce(jsonOk(makeBrowseResult(HOME, [], null)));
    const fns = render();
    await flush();

    const cancelBtn = findButtonByText('收起浏览');
    expect(cancelBtn).toBeTruthy();
    act(() => {
      cancelBtn!.click();
    });

    expect(fns.onCancel).toHaveBeenCalledTimes(1);
  });

  // ── Active project highlight ──────────────────────────

  it('highlights the active project directory', async () => {
    const activePath = `${HOME}/projects/cat-cafe`;
    mockApiFetch.mockReturnValueOnce(
      jsonOk(
        makeBrowseResult(`${HOME}/projects`, [
          { name: 'cat-cafe', path: activePath },
          { name: 'other', path: `${HOME}/projects/other` },
        ]),
      ),
    );
    render({ initialPath: `${HOME}/projects`, activeProjectPath: activePath });
    await flush();

    expect(container.textContent).toContain('当前项目');
  });

  // ── Error handling ────────────────────────────────────

  it('shows error when browse API fails', async () => {
    mockApiFetch.mockReturnValueOnce(jsonFail(403, 'Access denied'));
    render();
    await flush();

    expect(container.textContent).toContain('Access denied');
  });

  // ── Empty directory ───────────────────────────────────

  it('shows "No subdirectories" for empty directory', async () => {
    mockApiFetch.mockReturnValueOnce(jsonOk(makeBrowseResult(`${HOME}/empty`, [])));
    render({ initialPath: `${HOME}/empty` });
    await flush();

    expect(container.textContent).toContain('No subdirectories');
  });

  // ── Windows path support ──────────────────────────────

  it('handles Windows-style paths with backslashes in breadcrumbs', async () => {
    const winHome = 'C:\\Users\\test';
    mockApiFetch.mockReturnValueOnce(
      jsonOk({
        current: `${winHome}\\projects\\cat-cafe`,
        name: 'cat-cafe',
        parent: `${winHome}\\projects`,
        homePath: winHome,
        isWindows: true,
        entries: [{ name: 'src', path: `${winHome}\\projects\\cat-cafe\\src`, isDirectory: true }],
      }),
    );
    render({ initialPath: `${winHome}\\projects\\cat-cafe` });
    await flush();

    // Breadcrumb should parse correctly: Home > projects > cat-cafe
    expect(container.textContent).toContain('Home');
    expect(container.textContent).toContain('projects');
    expect(container.textContent).toContain('cat-cafe');
    expect(container.textContent).toContain('src');
  });

  it('shows the drive letter as a breadcrumb segment for Windows drive paths outside home', async () => {
    // F113: a path like D:\XXX must render "此电脑 > D: > XXX" (VS Code style:
    // drive letter without trailing separator). homePath is on C: so D: is outside home.
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    mockApiFetch.mockReturnValueOnce(
      jsonOk({
        current: 'D:\\Projects',
        name: 'Projects',
        parent: driveRoot,
        homePath: winHome,
        isWindows: true,
        entries: [{ name: 'src', path: 'D:\\Projects\\src', isDirectory: true }],
      }),
    );
    // Also mock the drives endpoint (the component may fetch it lazily —
    // if not called, this mock is simply unused, which is fine).
    mockApiFetch.mockReturnValueOnce(jsonOk({ drives: [{ letter: 'D', path: driveRoot, label: '本地磁盘 (D:)' }] }));

    render({ initialPath: 'D:\\Projects' });
    await flush();

    // The drive root must appear as its own breadcrumb segment so the user
    // can click back to D:\. Without the fix, only "Projects" showed.
    const driveButton = getAllButtons().find((b) => b.textContent?.includes('D:'));
    expect(driveButton).toBeTruthy();
    // Drive label is "D:" (no trailing backslash) — never the raw "D:\"
    expect(driveButton?.textContent).not.toContain('\\');
    // And the leaf folder is still present
    expect(container.textContent).toContain('Projects');
  });

  // ── Path input navigation ─────────────────────────────

  it('navigates to typed path on Enter key', async () => {
    mockApiFetch.mockReturnValueOnce(
      jsonOk(makeBrowseResult(HOME, [{ name: 'projects', path: `${HOME}/projects` }], null)),
    );
    render();
    await flush();

    // Type a new path
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    mockApiFetch.mockReturnValueOnce(jsonOk(makeBrowseResult('/tmp/test', [{ name: 'data', path: '/tmp/test/data' }])));
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/tmp/test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockApiFetch).toHaveBeenCalledWith(`/api/projects/browse?path=${encodeURIComponent('/tmp/test')}`);
    expect(container.textContent).toContain('data');
  });

  // ── Stale state after error (cloud P2) ────────────────

  it('keeps current listing on browse error and shows error message', async () => {
    // First: successful load
    mockApiFetch.mockReturnValueOnce(
      jsonOk(makeBrowseResult(`${HOME}/projects`, [{ name: 'cat-cafe', path: `${HOME}/projects/cat-cafe` }])),
    );
    const fns = render({ initialPath: `${HOME}/projects` });
    await flush();

    expect(fns.onCurrentPathChange).toHaveBeenCalledWith(`${HOME}/projects`);
    expect(container.textContent).toContain('cat-cafe');

    // Navigate to a forbidden path
    mockApiFetch.mockReturnValueOnce(jsonFail(403, 'Access denied'));
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/root/evil');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Error banner shown AND listing still visible (non-destructive)
    expect(container.textContent).toContain('Access denied');
    expect(container.textContent).toContain('cat-cafe');
    expect(findButtonByText('选择此目录')).toBeFalsy();
    expect(fns.onCurrentPathChange).toHaveBeenCalledTimes(1);
  });

  // ── Non-home path breadcrumbs (cloud P2) ──────────────

  it('shows all breadcrumb segments clickable for paths outside $HOME', async () => {
    mockApiFetch.mockReturnValueOnce(
      jsonOk({
        current: '/tmp/workspace/project',
        name: 'project',
        parent: '/tmp/workspace',
        homePath: HOME,
        entries: [{ name: 'src', path: '/tmp/workspace/project/src', isDirectory: true }],
      }),
    );
    render({ initialPath: '/tmp/workspace/project' });
    await flush();

    // Should show path segments
    expect(container.textContent).toContain('tmp');
    expect(container.textContent).toContain('workspace');
    expect(container.textContent).toContain('project');
    expect(container.textContent).toContain('src');

    // All non-current segments should be clickable buttons
    // (backend handles 403 for non-allowed ancestors gracefully)
    const tmpButton = getAllButtons().find((b) => b.textContent === 'tmp');
    expect(tmpButton).toBeTruthy();
    const wsButton = getAllButtons().find((b) => b.textContent === 'workspace');
    expect(wsButton).toBeTruthy();
  });

  it('falls back to homedir with visible info when initialPath returns 403', async () => {
    // initialPath 403 → visible fallback to homedir (not silent!)
    mockApiFetch.mockReturnValueOnce(jsonFail(403, 'Path not allowed'));
    mockApiFetch.mockReturnValueOnce(
      jsonOk(makeBrowseResult(HOME, [{ name: 'projects', path: `${HOME}/projects` }], null)),
    );
    render({ initialPath: '/restricted/path' });
    await flush();

    // Falls back: 2 API calls (initial + homedir)
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    // Shows visible info banner (not silent)
    expect(container.textContent).toContain('配置路径不可用');
    // Shows homedir contents
    expect(container.textContent).toContain('projects');
  });

  it('does NOT fallback on 400 (shows error directly)', async () => {
    mockApiFetch.mockReturnValueOnce(jsonFail(400, 'Cannot read directory'));
    render({ initialPath: '/broken/mount' });
    await flush();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Cannot read directory');
  });

  it('clears create-folder state when entering drives view (no stale parentPath)', async () => {
    // Regression (R2 review): start create-folder in a directory, then enter
    // 此电脑 drive-picker view. The inline editor + new-folder input must not
    // survive the transition - otherwise handleCreateDir posts parentPath from
    // the stale previous directory, a wrong-location filesystem mutation.
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    mockApiFetch.mockReturnValueOnce(
      jsonOk({
        current: 'D:\\Projects',
        name: 'Projects',
        parent: driveRoot,
        homePath: winHome,
        isWindows: true,
        entries: [{ name: 'src', path: 'D:\\Projects\\src', isDirectory: true }],
      }),
    );
    mockApiFetch.mockReturnValueOnce(jsonOk({ drives: [{ letter: 'D', path: driveRoot, label: '本地磁盘 (D:)' }] }));

    render({ initialPath: 'D:\\Projects' });
    await flush();

    // Start create-folder in D:\Projects -> inline editor opens
    const newBtn = findButtonByText('新建');
    expect(newBtn).toBeTruthy();
    await act(async () => {
      newBtn!.click();
    });
    // Inline editor is now visible (folder-name input rendered).
    // Use the specific placeholder to distinguish from the path input bar.
    const folderInput = () => container.querySelector('input[placeholder="文件夹名称..."]');
    expect(folderInput()).toBeTruthy();

    // Enter drives view ("此电脑" breadcrumb button)
    await act(async () => {
      const thisPc = findButtonByText('此电脑');
      expect(thisPc).toBeTruthy();
      thisPc!.click();
    });
    await flush();

    // After entering drives view: no create-folder controls remain.
    // The 新建 button is hidden AND the inline editor/input is cleared.
    expect(findButtonByText('新建')).toBeUndefined();
    expect(folderInput()).toBeNull();
    // Virtual root is not a concrete directory; do not keep the previously
    // browsed directory in the manual path input.
    expect((container.querySelector('input[placeholder="Enter path..."]') as HTMLInputElement).value).toBe('');
    // R2 follow-up P1: drives view must not render the stale directory
    // breadcrumb. The old segment "Projects" (from D:\Projects) must not
    // appear in the breadcrumb row while viewing 此电脑 (it renders as a
    // non-button span when it is the leaf, so check textContent not buttons).
    expect(container.textContent).not.toContain('Projects');
  });

  it('hides 此电脑 entry when server capability isWindows is false', async () => {
    // R4 P2#3: server capability (not path shape) controls whether 此电脑 appears.
    // A non-Windows browse result (isWindows absent/false) must not show the entry.
    mockApiFetch.mockReturnValue(
      jsonOk({
        current: '/home/user/projects',
        name: 'projects',
        parent: '/home/user',
        homePath: HOME,
        entries: [{ name: 'cat-cafe', path: `${HOME}/cat-cafe`, isDirectory: true }],
        // isWindows absent -> false
      }),
    );
    render();
    await flush();

    expect(findButtonByText('此电脑')).toBeUndefined();
  });

  it('shows 此电脑 entry when server capability isWindows is true', async () => {
    // Even with a non-Windows-looking path, server isWindows:true shows the entry.
    mockApiFetch.mockReturnValue(
      jsonOk({
        current: '/home/user/projects',
        name: 'projects',
        parent: '/home/user',
        homePath: HOME,
        entries: [],
        isWindows: true,
      }),
    );
    render();
    await flush();

    expect(findButtonByText('此电脑')).toBeTruthy();
  });

  it('shows a discoverable 此电脑 row in the directory list on Windows', async () => {
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    mockApiFetch.mockReturnValueOnce(
      jsonOk({
        current: 'D:\\Projects',
        name: 'Projects',
        parent: driveRoot,
        homePath: winHome,
        entries: [{ name: 'src', path: 'D:\\Projects\\src', isDirectory: true }],
        isWindows: true,
      }),
    );
    mockApiFetch.mockReturnValueOnce(jsonOk({ drives: [{ letter: 'D', path: driveRoot, label: '本地磁盘 (D:)' }] }));

    render({ initialPath: 'D:\\Projects' });
    await flush();

    const thisPcButtons = getAllButtons().filter((button) => button.textContent?.includes('此电脑'));
    expect(thisPcButtons).toHaveLength(2);
    const listEntry = thisPcButtons.find((button) => button.textContent?.includes('切换磁盘'));
    expect(listEntry).toBeTruthy();

    await act(async () => {
      listEntry!.click();
    });
    await flush();

    expect(container.textContent).toContain('本地磁盘 (D:)');
  });

  it('shows loading state then drives when entering drives view', async () => {
    // R4 P1#2 regression: pending -> loading -> ready state machine.
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    // First call: browse. Second call (drives): resolve after a tick.
    let resolveDrives: (v: unknown) => void = () => {};
    mockApiFetch
      .mockReturnValueOnce(
        jsonOk({
          current: 'D:\\Projects',
          name: 'Projects',
          parent: driveRoot,
          homePath: winHome,
          entries: [],
          isWindows: true,
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDrives = resolve;
        }),
      );

    render({ initialPath: 'D:\\Projects' });
    await flush();

    // Enter drives view
    await act(async () => {
      findButtonByText('此电脑')!.click();
    });

    // Drives request is pending -> loading state
    expect(container.textContent).toContain('正在加载磁盘列表');

    // Resolve drives
    await act(async () => {
      resolveDrives(jsonOk({ drives: [{ letter: 'D', path: driveRoot, label: '本地磁盘 (D:)' }], isWindows: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    // Ready -> drive grid shows
    expect(container.textContent).toContain('本地磁盘 (D:)');
  });

  it('recovers to ready after retry (error -> retry -> ready)', async () => {
    // R5: exercise the full retry transition, not just the button.
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    mockApiFetch
      .mockReturnValueOnce(
        jsonOk({
          current: 'D:\\Projects',
          name: 'Projects',
          parent: driveRoot,
          homePath: winHome,
          entries: [],
          isWindows: true,
        }),
      )
      .mockReturnValueOnce(jsonFail(500, 'server error'))
      .mockReturnValueOnce(
        jsonOk({ drives: [{ letter: 'D', path: driveRoot, label: '本地磁盘 (D:)' }], isWindows: true }),
      );

    render({ initialPath: 'D:\\Projects' });
    await flush();

    await act(async () => {
      findButtonByText('此电脑')!.click();
    });
    await flush();

    // Error state
    expect(container.textContent).toContain('磁盘列表加载失败');
    expect(findButtonByText('重试')).toBeTruthy();

    // Click retry -> idle -> loading -> ready
    await act(async () => {
      findButtonByText('重试')!.click();
    });
    await flush();

    // Ready -> drive grid shows (recovered)
    expect(container.textContent).toContain('本地磁盘 (D:)');
    expect(container.textContent).not.toContain('磁盘列表加载失败');
  });

  it('shows 未发现可用磁盘 when ready but no drives', async () => {
    // R5: empty-state coverage (ready + [] -> 未发现可用磁盘).
    const winHome = 'C:\\Users\\test';
    const driveRoot = 'D:\\';
    mockApiFetch
      .mockReturnValueOnce(
        jsonOk({
          current: 'D:\\Projects',
          name: 'Projects',
          parent: driveRoot,
          homePath: winHome,
          entries: [],
          isWindows: true,
        }),
      )
      .mockReturnValueOnce(jsonOk({ drives: [], isWindows: true }));

    render({ initialPath: 'D:\\Projects' });
    await flush();

    await act(async () => {
      findButtonByText('此电脑')!.click();
    });
    await flush();

    // Ready + empty -> 未发现可用磁盘 (not loading, not error)
    expect(container.textContent).toContain('未发现可用磁盘');
    expect(container.textContent).not.toContain('正在加载磁盘列表');
    expect(container.textContent).not.toContain('磁盘列表加载失败');
  });
});
