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
function noContent() {
  return Promise.resolve({ ok: false, status: 204, json: () => Promise.resolve({}) });
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
    expect(container.textContent).toContain('cat-cafe');
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
    const existingPath = '/home/user';
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

  it('confirm button is disabled when no project is selected', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);
  });

  // ── F068: Pick directory button ────────────────────────────

  it('shows "选择文件夹" button', async () => {
    setupCwdSuccess();
    render();
    await flush();
    const pickBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('选择文件夹'));
    expect(pickBtn).toBeTruthy();
  });

  it('selects path via pick-directory and confirms to create', async () => {
    const pickedPath = '/home/user';
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      if (path === '/api/projects/pick-directory' && opts?.method === 'POST') {
        return jsonOk({ path: pickedPath, name: 'new-project' });
      }
      return jsonFail();
    });
    const fns = render();
    await flush();
    const pickBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('选择文件夹'),
    )!;
    await act(async () => {
      pickBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/pick-directory', { method: 'POST' });
    expect(fns.onSelect).not.toHaveBeenCalled(); // not yet — just selected
    clickConfirm();
    expect(fns.onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: pickedPath }));
  });

  it('does not call onSelect when user cancels native picker (204)', async () => {
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: CWD_PATH });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      if (path === '/api/projects/pick-directory' && opts?.method === 'POST') return noContent();
      return jsonFail();
    });
    const fns = render();
    await flush();
    const pickBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('选择文件夹'),
    )!;
    await act(async () => {
      pickBtn.click();
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
    const canonicalPath = '/home/user';
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
      nativeInputValueSetter.call(input, '/home/user');
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
