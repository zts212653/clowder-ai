import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPickerModal } from '../DirectoryPickerModal';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

describe('DirectoryPickerModal bootcamp entry', () => {
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
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonOk({ path: '/test' });
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return jsonOk({});
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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

  it('shows a bootcamp entry in the project list', async () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        React.createElement(DirectoryPickerModal, {
          existingProjects: [],
          onSelect,
          onCancel: vi.fn(),
        }),
      );
    });
    await flush();

    const bootcampBtn = container.querySelector('[data-testid="picker-bootcamp"]');
    expect(bootcampBtn).not.toBeNull();
    expect(bootcampBtn?.textContent).toContain('训练营');
  });

  it('calls onSelect with bootcamp flag when bootcamp entry is chosen and confirmed', async () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        React.createElement(DirectoryPickerModal, {
          existingProjects: [],
          onSelect,
          onCancel: vi.fn(),
        }),
      );
    });
    await flush();

    const bootcampBtn = container.querySelector('[data-testid="picker-bootcamp"]') as HTMLButtonElement;
    await act(async () => {
      bootcampBtn.click();
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建对话'),
    );
    expect(confirmButton).not.toBeNull();
    await act(async () => {
      confirmButton!.click();
    });
    await flush();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      bootcamp: true,
    });
  });

  it('does not render bootcamp sentinel as a browsed-path directory entry', async () => {
    act(() => {
      root.render(
        React.createElement(DirectoryPickerModal, {
          existingProjects: [],
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });
    await flush();

    const bootcampBtn = container.querySelector('[data-testid="picker-bootcamp"]') as HTMLButtonElement;
    await act(async () => {
      bootcampBtn.click();
    });

    const allButtons = Array.from(container.querySelectorAll('button'));
    const folderButtons = allButtons.filter((b) => b.getAttribute('title') === 'bootcamp');
    expect(folderButtons).toHaveLength(0);
  });
});
