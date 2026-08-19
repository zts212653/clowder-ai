import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const FIRST_PATH = '/home/user/projects/first-project';
const LONG_PATH = '/home/user/projects/F269-这是一个非常长的项目路径-包含中文与家庭emoji-👨‍👩‍👧‍👦-需要完整复制';
const LONG_PROJECT_NAME = 'F269-这是一个非常长的项目路径-包含中文与家庭emoji-👨‍👩‍👧‍👦-需要完整复制';
const LONG_CAT_LABEL = '缅因猫（一个非常长且需要完整恢复的生产排障身份）';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: () => LONG_CAT_LABEL,
  useCatData: () => ({
    getCatById: () => ({ id: 'codex-sol' }),
  }),
}));

vi.mock('../CatSelector', () => ({
  CatSelector: ({ onSelectionChange }: { onSelectionChange: (catIds: string[]) => void }) => (
    <button type="button" onClick={() => onSelectionChange(['codex-sol'])}>
      选择长名猫
    </button>
  ),
}));

import { DirectoryPickerModal } from '../DirectoryPickerModal';

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

function jsonFail(status = 500, error = 'fail') {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });
}

function setInlineOverflow(element: Element) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 80 },
    scrollWidth: { configurable: true, value: 800 },
  });
}

async function measureOverflow(...elements: Element[]) {
  for (const element of elements) setInlineOverflow(element);
  await act(async () => window.dispatchEvent(new Event('resize')));
}

function measuredValue(container: ParentNode, value: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]')).find(
    (element) => element.textContent === value,
  );
}

describe('DirectoryPickerModal recoverable overflow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/projects/cwd') return jsonFail();
      if (path === '/api/backlog/items') return jsonOk({ items: [] });
      return jsonFail();
    });
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

  async function render() {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <DirectoryPickerModal existingProjects={[FIRST_PATH, LONG_PATH]} onSelect={onSelect} onCancel={vi.fn()} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return onSelect;
  }

  function confirm() {
    const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('创建对话'),
    );
    expect(button).toBeTruthy();
    act(() => button?.click());
  }

  it('selects a project when the row body is clicked, not only its explicit button', async () => {
    const onSelect = await render();
    const option = Array.from(container.querySelectorAll<HTMLElement>('[data-project-option]')).find((candidate) =>
      candidate.textContent?.includes(LONG_PROJECT_NAME),
    );
    if (!option) throw new Error('Expected the long project row to render');

    const name = measuredValue(option, LONG_PROJECT_NAME);
    if (!name) throw new Error('Expected the project name to render inside the row');

    act(() => name.click());
    confirm();

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: LONG_PATH }));
  });

  it('recovers long project labels without nesting or activating the project row', async () => {
    const onSelect = await render();
    const option = Array.from(container.querySelectorAll<HTMLElement>('[data-project-option]')).find((candidate) =>
      candidate.textContent?.includes(LONG_PROJECT_NAME),
    );
    if (!option) throw new Error('Expected the long project row to render');
    const selectProject = option.querySelector<HTMLButtonElement>('button[data-project-path]');
    expect(selectProject?.tagName).toBe('BUTTON');

    const name = measuredValue(option, LONG_PROJECT_NAME);
    const path = measuredValue(option, LONG_PATH);
    if (!name) throw new Error('Expected the long project name to expose an overflow measurement target');
    if (!path) throw new Error('Expected the long project path to expose an overflow measurement target');

    await measureOverflow(name, path);
    const copyPath = option.querySelector<HTMLButtonElement>('button[aria-label="复制完整项目路径"]');
    expect(copyPath).toBeTruthy();
    expect(container.querySelector('button button')).toBeNull();
    expect(container.querySelector('[role="button"] button')).toBeNull();
    expect(selectProject?.contains(copyPath ?? null)).toBe(false);

    await act(async () => copyPath?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_PATH);

    confirm();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: FIRST_PATH }));
  });

  it('keeps project selection keyboard-operable and makes the full cat label recoverable', async () => {
    const onSelect = await render();
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-project-option]')).find((candidate) =>
      candidate.textContent?.includes(LONG_PROJECT_NAME),
    );
    const selectProject = row?.querySelector<HTMLButtonElement>('button[data-project-path]');
    expect(selectProject?.tabIndex).toBe(0);

    act(() => selectProject?.click());
    confirm();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectPath: LONG_PATH }));

    const catsToggle = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('选猫猫'),
    );
    act(() => catsToggle?.click());
    const chooseCat = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('选择长名猫'),
    );
    act(() => chooseCat?.click());
    const bindToggle = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('绑定外部 Session'),
    );
    act(() => bindToggle?.click());

    const catLabel = measuredValue(container, LONG_CAT_LABEL);
    if (!catLabel) throw new Error('Expected the long cat label to expose an overflow measurement target');
    await measureOverflow(catLabel);

    const copyCat = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整猫猫名称"]');
    expect(copyCat).toBeTruthy();
    expect(container.querySelector(`[title="${LONG_CAT_LABEL}"]`)).toBeNull();
    await act(async () => copyCat?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_CAT_LABEL);
  });

  it('uses a compact check instead of visible selection CTA text', async () => {
    await render();
    const selectedRow = Array.from(container.querySelectorAll<HTMLElement>('[data-project-option]')).find((candidate) =>
      candidate.textContent?.includes(FIRST_PATH),
    );
    if (!selectedRow) throw new Error('Expected the initially selected project row');

    const selectProject = selectedRow.querySelector<HTMLButtonElement>('button[data-project-path]');
    expect(selectProject?.getAttribute('aria-pressed')).toBe('true');
    expect(selectedRow.querySelector('[data-selection-indicator]')).toBeTruthy();
    expect(
      Array.from(selectedRow.querySelectorAll('[aria-hidden="true"]')).some(
        (element) => element.textContent?.trim() === '已选择' || element.textContent?.trim() === '选择',
      ),
    ).toBe(false);
  });
});
