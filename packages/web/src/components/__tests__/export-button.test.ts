import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportButton } from '@/components/ExportButton';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

let mockApiFetch: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Save original before any spying
const origCreateElement = document.createElement.bind(document);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = origCreateElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockApiFetch = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderButton(threadId = 'thread-1') {
  act(() => {
    root.render(React.createElement(ExportButton, { threadId }));
  });
}

function getToggle(): HTMLButtonElement {
  return container.querySelector('button[aria-label="导出对话"]') as HTMLButtonElement;
}

function getMenu(): HTMLDivElement | null {
  return container.querySelector('.absolute');
}

function getMenuButtons(): HTMLButtonElement[] {
  const menu = getMenu();
  if (!menu) return [];
  return Array.from(menu.querySelectorAll('button'));
}

/** Mock downloadBlob side effects (URL.createObjectURL + <a>.click) */
function mockDownload() {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();

  const clickSpy = vi.fn();
  const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'a') {
      return { href: '', download: '', click: clickSpy } as unknown as HTMLAnchorElement;
    }
    return origCreateElement(tag);
  });

  return {
    clickSpy,
    restore() {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      spy.mockRestore();
    },
  };
}

describe('ExportButton', () => {
  it('renders icon-only button with correct aria-label', () => {
    renderButton();
    const btn = getToggle();
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('导出对话');
    expect(btn.getAttribute('title')).toBe('导出对话');
  });

  it('does not show menu initially', () => {
    renderButton();
    expect(getMenu()).toBeNull();
  });

  it('opens dropdown menu on click', () => {
    renderButton();
    act(() => {
      getToggle().click();
    });
    expect(getMenu()).toBeTruthy();
    const items = getMenuButtons();
    expect(items.length).toBe(3);
  });

  it('shows all three export format options', () => {
    renderButton();
    act(() => {
      getToggle().click();
    });
    const items = getMenuButtons();
    const labels = items.map((b) => b.textContent);
    expect(labels.some((t) => t?.includes('PNG'))).toBe(true);
    expect(labels.some((t) => t?.includes('Markdown'))).toBe(true);
    expect(labels.some((t) => t?.includes('纯文本'))).toBe(true);
  });

  it('toggles menu closed on second click', () => {
    renderButton();
    act(() => {
      getToggle().click();
    });
    expect(getMenu()).toBeTruthy();
    act(() => {
      getToggle().click();
    });
    expect(getMenu()).toBeNull();
  });

  it('closes menu on outside click', () => {
    renderButton();
    act(() => {
      getToggle().click();
    });
    expect(getMenu()).toBeTruthy();
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(getMenu()).toBeNull();
  });

  it('calls apiFetch with correct URL for txt export', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '对话记录: test',
    });
    const dl = mockDownload();

    renderButton('thread-42');
    act(() => {
      getToggle().click();
    });
    const txtBtn = getMenuButtons().find((b) => b.textContent?.includes('纯文本'));
    expect(txtBtn).toBeTruthy();

    await act(async () => {
      txtBtn?.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/export/thread/thread-42?format=txt');
    expect(dl.clickSpy).toHaveBeenCalled();
    dl.restore();
  });

  it('calls apiFetch with POST for png export', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(['png-data'], { type: 'image/png' }),
    });
    const dl = mockDownload();

    renderButton('thread-99');
    act(() => {
      getToggle().click();
    });
    const pngBtn = getMenuButtons().find((b) => b.textContent?.includes('PNG'));

    await act(async () => {
      pngBtn?.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-99/export-image', { method: 'POST' });
    dl.restore();
  });

  it('calls apiFetch with correct URL for md export', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '# 对话记录',
    });
    const dl = mockDownload();

    renderButton('thread-77');
    act(() => {
      getToggle().click();
    });
    const mdBtn = getMenuButtons().find((b) => b.textContent?.includes('Markdown'));

    await act(async () => {
      mdBtn?.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/export/thread/thread-77?format=md');
    expect(dl.clickSpy).toHaveBeenCalled();
    dl.restore();
  });

  it('closes menu when export option is clicked', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data',
    });
    const dl = mockDownload();

    renderButton();
    act(() => {
      getToggle().click();
    });
    expect(getMenu()).toBeTruthy();

    const txtBtn = getMenuButtons().find((b) => b.textContent?.includes('纯文本'));
    await act(async () => {
      txtBtn?.click();
    });

    // Menu should close after clicking an option
    expect(getMenu()).toBeNull();
    dl.restore();
  });
});
