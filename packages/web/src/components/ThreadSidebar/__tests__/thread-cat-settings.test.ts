/**
 * F32-b Phase 3: ThreadCatSettings — settings popover for existing thread preferredCats.
 * Tests the "open → select cat → save → onSave called" path.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadCatSettings } from '../ThreadCatSettings';

// ── Mock apiFetch (used by useCatData inside CatSelector) ──
vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3003',
}));

describe('ThreadCatSettings', () => {
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

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function render(props: Partial<React.ComponentProps<typeof ThreadCatSettings>> = {}) {
    const defaults = {
      threadId: 'thread-123',
      currentCats: [] as string[],
      onSave: vi.fn().mockResolvedValue(undefined),
      ...props,
    };
    act(() => {
      root.render(React.createElement(ThreadCatSettings, defaults));
    });
    return defaults;
  }

  it('opens popover, selects a cat, and calls onSave with selected cats', async () => {
    const fns = render();
    await flush();

    // Click the settings button to open popover
    const settingsBtn = container.querySelector('button[title="设置默认猫猫"]');
    expect(settingsBtn).toBeTruthy();
    act(() => {
      (settingsBtn as HTMLElement).click();
    });

    // Popover should now be open — CatSelector renders cat chips from /api/cats data
    // Find and click the 布偶猫 chip
    const catChip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('布偶猫'));
    expect(catChip).toBeTruthy();
    act(() => {
      catChip?.click();
    });

    // Save button should now be enabled (hasChanged = true)
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    expect(saveBtn).toBeTruthy();
    expect(saveBtn?.hasAttribute('disabled')).toBe(false);

    // Click save
    await act(async () => {
      saveBtn?.click();
    });

    // onSave should have been called with threadId and selected cats
    expect(fns.onSave).toHaveBeenCalledWith('thread-123', ['opus']);
  });

  it('save button is disabled when no change has been made', async () => {
    render({ currentCats: ['opus'] });
    await flush();

    // Open popover
    const settingsBtn = container.querySelector('button[title="设置默认猫猫"]');
    act(() => {
      (settingsBtn as HTMLElement).click();
    });

    // opus is already selected, so no change → save should be disabled
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    expect(saveBtn).toBeTruthy();
    expect(saveBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('cancel reverts selection and closes popover', async () => {
    const fns = render();
    await flush();

    // Open popover
    const settingsBtn = container.querySelector('button[title="设置默认猫猫"]');
    act(() => {
      (settingsBtn as HTMLElement).click();
    });

    // Select a cat
    const catChip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('布偶猫'));
    act(() => {
      catChip?.click();
    });

    // Click cancel
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '取消');
    act(() => {
      cancelBtn?.click();
    });

    // Popover should be closed (no "保存" button visible)
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    expect(saveBtn).toBeFalsy();

    // onSave should not have been called
    expect(fns.onSave).not.toHaveBeenCalled();
  });

  it('shows error and keeps popover open when onSave rejects', async () => {
    render({ onSave: vi.fn().mockRejectedValue(new Error('网络错误')) });
    await flush();

    // Open popover
    const settingsBtn = container.querySelector('button[title="设置默认猫猫"]');
    act(() => {
      (settingsBtn as HTMLElement).click();
    });

    // Select a cat
    const catChip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('布偶猫'));
    act(() => {
      catChip?.click();
    });

    // Click save (will reject)
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    await act(async () => {
      saveBtn?.click();
    });

    // Popover should still be open (save button still visible)
    const saveBtnAfter = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    expect(saveBtnAfter).toBeTruthy();

    // Error message should be shown
    expect(container.textContent).toContain('保存失败');

    // Save button should not be disabled (isSaving reset, hasChanged still true)
    expect(saveBtnAfter?.hasAttribute('disabled')).toBe(false);
  });

  it('clear button resets selection to empty', async () => {
    const fns = render({ currentCats: ['opus', 'codex'] });
    await flush();

    // Open popover
    const settingsBtn = container.querySelector('button[title="设置默认猫猫"]');
    act(() => {
      (settingsBtn as HTMLElement).click();
    });

    // Click "清除" to clear all selections
    const clearBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '清除');
    expect(clearBtn).toBeTruthy();
    act(() => {
      clearBtn?.click();
    });

    // Save should now be enabled (changed from ['opus','codex'] to [])
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存');
    expect(saveBtn?.hasAttribute('disabled')).toBe(false);

    // Save the cleared state
    await act(async () => {
      saveBtn?.click();
    });
    expect(fns.onSave).toHaveBeenCalledWith('thread-123', []);
  });
});
