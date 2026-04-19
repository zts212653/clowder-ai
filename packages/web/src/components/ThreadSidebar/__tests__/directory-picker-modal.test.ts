import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPickerModal } from '../DirectoryPickerModal';

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

const CWD_PATH = '/path/to/project';

describe('DirectoryPickerModal', () => {
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

  function render(props: Partial<React.ComponentProps<typeof DirectoryPickerModal>> = {}) {
    const defaults = {
      existingProjects: [] as string[],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    };
    act(() => {
      root.render(React.createElement(DirectoryPickerModal, defaults));
    });
    return defaults;
  }

  function setupCwdSuccess() {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return jsonFail();
    });
  }

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  // ── cwd fetch ──────────────────────────────────────────────

  it('fetches cwd on mount and displays recommended quick pick', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    expect(container.textContent).toContain('project');
    expect(container.textContent).toContain('推荐');
    expect(container.textContent).toContain(CWD_PATH);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/cwd');
    expect(fns.onSelect).not.toHaveBeenCalled();
  });

  it('does not show cwd in quick picks when it already exists in existingProjects', async () => {
    setupCwdSuccess();
    render({ existingProjects: [CWD_PATH] });
    await flush();
    expect(container.textContent).not.toContain('推荐');
  });

  // ── F068-R7: Helper to click confirm button after selecting ──
  function clickConfirm() {
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    );
    expect(confirmBtn).toBeTruthy();
    act(() => {
      confirmBtn?.click();
    });
  }

  // ── Quick pick selection (two-step: select then confirm) ──

  it('calls onSelect with cwd path when recommended quick pick is selected and confirmed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    const cwdBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('推荐'));
    expect(cwdBtn).toBeTruthy();
    act(() => {
      cwdBtn?.click();
    });
    expect(fns.onSelect).not.toHaveBeenCalled(); // not yet — just selected
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: CWD_PATH }));
  });

  it('calls onSelect with existing project path when selected and confirmed', async () => {
    const existingPath = '/home/user/other';
    setupCwdSuccess();
    const fns = render({ existingProjects: [existingPath] });
    await flush();
    const projectBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('other'));
    expect(projectBtn).toBeTruthy();
    act(() => {
      projectBtn?.click();
    });
    expect(fns.onSelect).not.toHaveBeenCalled();
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: existingPath }));
  });

  // ── Lobby selection (two-step) ─────────────────────────────

  it('calls onSelect(undefined) when lobby is selected and confirmed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    const lobbyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('大厅'));
    expect(lobbyBtn).toBeTruthy();
    act(() => {
      lobbyBtn?.click();
    });
    expect(fns.onSelect).not.toHaveBeenCalled();
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: undefined }));
  });

  it('confirm button is disabled when no project available at all', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonFail();
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return jsonFail();
    });
    render({ existingProjects: [] });
    await flush();
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);
  });

  it('auto-selects cwdPath on mount so confirm button is enabled', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(false);
  });

  it('auto-selects first existing project when cwdPath unavailable', async () => {
    const existingPath = '/home/user/other';
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonFail();
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return jsonFail();
    });
    const fns = render({ existingProjects: [existingPath] });
    await flush();
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: existingPath }));
  });

  it('auto-selects cwdPath over existingProjects when both available', async () => {
    const existingPath = '/home/user/other';
    setupCwdSuccess();
    const fns = render({ existingProjects: [existingPath] });
    await flush();
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: CWD_PATH }));
  });

  // ── F113: Browse directory button (replaces F068 osascript picker) ──

  it('shows "浏览文件夹" button', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('浏览文件夹'),
    );
    expect(browseBtn).toBeTruthy();
  });

  it('toggles inline DirectoryBrowser when browse button is clicked', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('浏览文件夹'),
    )!;
    // Click to open browser panel
    await act(async () => {
      browseBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Button text changes to "收起浏览" when browser is open
    expect(browseBtn.textContent).toContain('收起浏览');
    // Click again to close
    await act(async () => {
      browseBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(browseBtn.textContent).toContain('浏览文件夹');
  });

  it('does not call onSelect just from toggling browser open', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('浏览文件夹'),
    )!;
    await act(async () => {
      browseBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fns.onSelect).not.toHaveBeenCalled();
  });

  // ── F068: Path input ──────────────────────────────────────

  it('shows path input field with placeholder', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const inputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
    const pathInput = inputs.find((i) => i.placeholder.includes('路径'));
    expect(pathInput).toBeTruthy();
  });

  it('validates path via browse API and selects it for confirmation', async () => {
    const canonicalPath = '/home/user/new-path';
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      if (path.startsWith('/api/projects/browse'))
        return jsonOk({ current: canonicalPath, name: 'new-path', parent: null, entries: [] });
      return jsonFail();
    });
    const fns = render();
    await flush();
    const input = Array.from(container.querySelectorAll('input[type="text"]')).find((i) =>
      (i as HTMLInputElement).placeholder.includes('路径'),
    ) as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(input, '/home/user/new-path');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const goBtn = container.querySelector('button[aria-label="跳转到路径"]') as HTMLButtonElement;
    expect(goBtn).toBeTruthy();
    await act(async () => {
      goBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fns.onSelect).not.toHaveBeenCalled(); // not yet
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: canonicalPath }));
  });

  it('shows error when path input validation fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      if (path.startsWith('/api/projects/browse')) return jsonFail(403, 'Access denied');
      return jsonFail();
    });
    const fns = render();
    await flush();
    const input = Array.from(container.querySelectorAll('input[type="text"]')).find((i) =>
      (i as HTMLInputElement).placeholder.includes('路径'),
    ) as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(input, '/root/evil');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const goBtn = container.querySelector('button[aria-label="跳转到路径"]') as HTMLButtonElement;
    await act(async () => {
      goBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fns.onSelect).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Access denied');
  });

  // ── F068: No more browse section ──────────────────────────

  it('does NOT show "浏览其他目录" toggle (removed in F068)', async () => {
    setupCwdSuccess();
    render();
    await flush();
    expect(container.textContent).not.toContain('浏览其他目录');
  });

  // ── Cat selection with preferredCats ──────────────────────

  it('passes selected cats as preferredCats when confirmed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    // Expand cat selector first (collapsed by default)
    const expandBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('选猫猫'));
    expect(expandBtn).toBeTruthy();
    act(() => {
      expandBtn?.click();
    });
    await flush();
    const catChip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('布偶猫'));
    expect(catChip).toBeTruthy();
    act(() => {
      catChip?.click();
    });
    const cwdBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('推荐'));
    act(() => {
      cwdBtn?.click();
    });
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: CWD_PATH, preferredCats: ['opus'] }),
    );
  });

  // ── F095 Phase C: Title input ────────────────────────────

  it('shows thread title input field', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const titleInput = Array.from(container.querySelectorAll('input')).find((i) =>
      (i as HTMLInputElement).placeholder.includes('对话标题'),
    ) as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    expect(titleInput.maxLength).toBe(200);
  });

  it('shows pin checkbox', async () => {
    setupCwdSuccess();
    render();
    await flush();
    expect(container.textContent).toContain('创建后置顶');
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
  });

  // ── F095 Phase C: Title/Pin/Backlog values flow into onSelect ──

  it('passes threadTitle in onSelect when title is filled and confirmed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    const titleInput = Array.from(container.querySelectorAll('input')).find((i) =>
      (i as HTMLInputElement).placeholder.includes('对话标题'),
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(titleInput, '我的新对话');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const cwdBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('推荐'));
    act(() => {
      cwdBtn?.click();
    });
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: '我的新对话' }));
  });

  it('passes pinned=true in onSelect when pin checkbox is checked and confirmed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    await flush();
    const cwdBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('推荐'));
    act(() => {
      cwdBtn?.click();
    });
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ pinned: true }));
  });

  it('passes backlogItemId in onSelect when feat is selected and confirmed', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items')
        return jsonOk({
          items: [
            { id: 'bl-001', title: 'F095 侧栏导航', status: 'in-progress' },
            { id: 'bl-002', title: 'F042 提示词审计', status: 'open' },
          ],
        });
      return jsonFail();
    });
    const fns = render();
    await flush();
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    act(() => {
      select.value = 'bl-001';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const cwdBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('推荐'));
    act(() => {
      cwdBtn?.click();
    });
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ backlogItemId: 'bl-001' }));
  });

  // ── Escape key ────────────────────────────────────────────

  it('calls onCancel when Escape key is pressed', async () => {
    setupCwdSuccess();
    const fns = render();
    await flush();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(fns.onCancel).toHaveBeenCalledTimes(1);
  });
});
