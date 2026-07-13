import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const testData = vi.hoisted(() => ({
  TEST_LABELS: [
    { id: 'lbl-a', name: '开源', color: '#5B8C5A', sortOrder: 0, createdBy: 'u1', createdAt: 1 },
    { id: 'lbl-b', name: '设计', color: '#C47F52', sortOrder: 1, createdBy: 'u1', createdAt: 2 },
  ],
}));

vi.mock('@/stores/label-store', () => {
  const store = {
    labels: testData.TEST_LABELS,
    isLoading: false,
    fetchLabels: vi.fn().mockResolvedValue(undefined),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    deleteLabel: vi.fn(),
  };
  const hook = Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store), {
    getState: () => store,
    setState: (partial: Partial<typeof store>) => Object.assign(store, partial),
  });
  return { useLabelStore: hook };
});

const inputValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
if (!inputValueDescriptor?.set) {
  throw new Error('HTMLInputElement value setter missing');
}
const nativeInputValueSetter = inputValueDescriptor.set;

async function typeInInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function makeThread(id: string, labels?: string[], projectPath = '/test') {
  return {
    id,
    title: `Thread ${id}`,
    projectPath,
    createdBy: 'u1',
    participants: [],
    lastActiveAt: 1000,
    createdAt: 1000,
    labels,
  };
}

describe('ThreadSidebar manual organizer', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    vi.useRealTimers();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  function findManualOrganizeButton(container: HTMLElement) {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.getAttribute('title')?.startsWith('手动批量分类'),
    );
  }

  it('has searchable thread rows and inline label management', async () => {
    const { useLabelStore } = await import('@/stores/label-store');
    type LabelStoreExt = ReturnType<typeof vi.fn> & {
      setState: (p: Record<string, unknown>) => void;
      getState: () => Record<string, unknown>;
    };
    const createLabelMock = vi.fn().mockResolvedValue({
      id: 'lbl-new',
      name: '新标签',
      color: '#5B8C5A',
      sortOrder: 2,
      createdBy: 'u1',
      createdAt: Date.now(),
    });
    const deleteLabelMock = vi.fn().mockResolvedValue(undefined);
    (useLabelStore as unknown as LabelStoreExt).setState({
      labels: testData.TEST_LABELS,
      createLabel: createLabelMock,
      deleteLabel: deleteLabelMock,
    });

    mockStore.threads = [
      makeThread('alpha', undefined, '/project/alpha'),
      makeThread('beta', undefined, '/project/beta'),
      makeThread('already-labeled', ['lbl-a'], '/project/alpha'),
    ];

    await harness.render();
    const btn = findManualOrganizeButton(harness.container);
    expect(btn).toBeTruthy();
    if (!btn) throw new Error('manual organize button not found');

    await act(async () => {
      btn.click();
    });
    await harness.flush();

    const modal = harness.container.querySelector('[data-testid="thread-organizer-modal"]') as HTMLElement | null;
    expect(modal).toBeTruthy();
    if (!modal) throw new Error('thread organizer modal not found');
    const search = modal.querySelector('input[placeholder="搜索对话、项目或 ID..."]') as HTMLInputElement | null;
    expect(search).toBeTruthy();
    if (!search) throw new Error('organizer search input not found');

    await typeInInput(search, 'alpha');
    await harness.flush();

    const alphaRow = modal.querySelector('[data-thread-id="alpha"]') as HTMLElement | null;
    expect(alphaRow).toBeTruthy();
    expect(alphaRow?.textContent).toContain('Thread alpha');
    expect(alphaRow?.textContent).toContain('/project/alpha');
    expect(modal.querySelector('[data-thread-id="beta"]')).toBeNull();

    const addLabelButton = Array.from(modal.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('添加标签'),
    );
    expect(addLabelButton).toBeTruthy();
    if (!addLabelButton) throw new Error('add label button not found');
    await act(async () => {
      addLabelButton.click();
    });
    await harness.flush();

    const labelNameInput = modal.querySelector('input[placeholder="标签名称"]') as HTMLInputElement | null;
    expect(labelNameInput).toBeTruthy();
    if (!labelNameInput) throw new Error('label name input not found');
    await typeInInput(labelNameInput, '新标签');
    await harness.flush();

    const createButton = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === '创建');
    expect(createButton).toBeTruthy();
    if (!createButton) throw new Error('create label button not found');
    await act(async () => {
      createButton.click();
    });
    await harness.flush();
    expect(createLabelMock).toHaveBeenCalledWith('新标签', expect.any(String));

    const deleteButton = modal.querySelector('[aria-label="删除标签 开源"]') as HTMLButtonElement | null;
    expect(deleteButton).toBeTruthy();
    if (!deleteButton) throw new Error('delete label button not found');
    await act(async () => {
      deleteButton.click();
    });
    await harness.flush();
    expect(deleteLabelMock).toHaveBeenCalledWith('lbl-a');
  });

  it('hides organize buttons when all threads are categorized', async () => {
    // Regression: organize buttons must only render when uncategorizedCount > 0
    mockStore.threads = [
      makeThread('labeled-1', ['lbl-a'], '/project/alpha'),
      makeThread('labeled-2', ['lbl-b'], '/project/beta'),
    ];

    await harness.render();

    const manualBtn = findManualOrganizeButton(harness.container);
    expect(manualBtn).toBeFalsy();

    // Auto-organize (sparkle) button should also be hidden
    const autoBtn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
      b.getAttribute('title')?.startsWith('猫猫帮你分类'),
    );
    expect(autoBtn).toBeFalsy();
  });
});
