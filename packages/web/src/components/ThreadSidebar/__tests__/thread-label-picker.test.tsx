import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoistedMocks = vi.hoisted(() => ({
  mockLabels: [] as {
    id: string;
    name: string;
    color: string;
    sortOrder: number;
    createdBy: string;
    createdAt: number;
  }[],
  mockFetchLabels: vi.fn(),
  mockCreateLabel: vi.fn(),
  mockDeleteLabel: vi.fn(),
  mockUpdateLabel: vi.fn(),
  mockIMEComposing: false,
}));

vi.mock('@/stores/label-store', () => {
  const storeState = () => ({
    labels: hoistedMocks.mockLabels,
    isLoading: false,
    fetchLabels: hoistedMocks.mockFetchLabels,
    createLabel: hoistedMocks.mockCreateLabel,
    deleteLabel: hoistedMocks.mockDeleteLabel,
    updateLabel: hoistedMocks.mockUpdateLabel,
  });
  const hook = Object.assign(storeState, { getState: storeState });
  return { useLabelStore: hook };
});

vi.mock('@/hooks/useIMEGuard', () => ({
  useIMEGuard: () => ({
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    isComposing: () => hoistedMocks.mockIMEComposing,
  }),
}));

import { ThreadLabelSettingsContent } from '../ThreadLabelPicker';

const nativeInputValueSetter = (() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('missing native input value setter');
  return setter;
})();

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function render(props: Partial<React.ComponentProps<typeof ThreadLabelSettingsContent>> = {}) {
  act(() => {
    root.render(
      React.createElement(ThreadLabelSettingsContent, {
        threadId: 't1',
        currentLabels: [],
        onSave: vi.fn(),
        ...props,
      }),
    );
  });
}

async function openPicker() {
  await flush();
}

async function openCreateForm() {
  const btn = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('新建标签'),
  );
  if (!btn) throw new Error('missing create-label button');
  await act(async () => btn.click());
  await flush();
}

async function typeInInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function fireKeyDown(el: HTMLElement, key: string, isComposing: boolean) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  Object.defineProperty(event, 'isComposing', { value: isComposing });
  el.dispatchEvent(event);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  hoistedMocks.mockLabels = [
    { id: 'l1', name: 'feat', color: '#3B82F6', sortOrder: 0, createdBy: 'u1', createdAt: 1 },
    { id: 'l2', name: 'bug', color: '#EF4444', sortOrder: 1, createdBy: 'u1', createdAt: 2 },
  ];
  hoistedMocks.mockFetchLabels.mockReset();
  hoistedMocks.mockCreateLabel.mockReset();
  hoistedMocks.mockDeleteLabel.mockReset();
  hoistedMocks.mockCreateLabel.mockResolvedValue({ id: 'l3', name: 'study', color: '#5B8C5A' });
  hoistedMocks.mockDeleteLabel.mockImplementation(async (id: string) => {
    hoistedMocks.mockLabels = hoistedMocks.mockLabels.filter((l) => l.id !== id);
  });
  hoistedMocks.mockIMEComposing = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ThreadLabelSettingsContent', () => {
  it('restores the saved labels when persistence fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('save failed'));
    render({ onSave });
    await openPicker();

    const featCheckbox = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (checkbox) => checkbox.closest('label')?.textContent?.includes('feat'),
    );
    await act(async () => featCheckbox?.click());
    const saveButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => saveButton?.click());
    await flush();

    expect(onSave).toHaveBeenCalledWith('t1', ['l1']);
    expect(featCheckbox?.checked).toBe(false);
    expect(container.textContent).toContain('保存失败，请重试');
  });

  describe('IME composition guard', () => {
    it('should NOT create label when Enter is pressed during IME composition', async () => {
      hoistedMocks.mockIMEComposing = true;
      render();
      await openPicker();
      await openCreateForm();

      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      await typeInInput(input, 'study');

      await act(async () => {
        fireKeyDown(input, 'Enter', true);
      });
      await flush();

      expect(hoistedMocks.mockCreateLabel).not.toHaveBeenCalled();
    });

    it('should create label when Enter is pressed without IME composition', async () => {
      hoistedMocks.mockIMEComposing = false;
      render();
      await openPicker();
      await openCreateForm();

      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      await typeInInput(input, 'study');

      await act(async () => {
        fireKeyDown(input, 'Enter', false);
      });
      await flush();

      expect(hoistedMocks.mockCreateLabel).toHaveBeenCalledWith('study', '#5B8C5A');
    });
  });

  describe('label deletion', () => {
    it('should show delete button for each label and call deleteLabel on click', async () => {
      render();
      await openPicker();

      const deleteButtons = container.querySelectorAll('[data-testid^="delete-label-"]');
      expect(deleteButtons.length).toBe(2);

      await act(async () => {
        (deleteButtons[0] as HTMLButtonElement).click();
      });
      await flush();

      expect(hoistedMocks.mockDeleteLabel).toHaveBeenCalledWith('l1');
    });

    it('should not unselect label when deleteLabel fails (label still in store)', async () => {
      const onSave = vi.fn();
      render({ currentLabels: ['l1', 'l2'], onSave });
      await openPicker();

      hoistedMocks.mockDeleteLabel.mockResolvedValue(undefined);

      const deleteBtn = container.querySelector('[data-testid="delete-label-l1"]') as HTMLButtonElement;
      await act(async () => deleteBtn.click());
      await flush();

      const checkboxes = container.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
      const l1Checkbox = Array.from(checkboxes).find(
        (cb) => cb.checked && cb.closest('label')?.textContent?.includes('feat'),
      );
      expect(l1Checkbox?.checked).toBe(true);
    });

    it('delete button has aria-label and becomes visible on focus', async () => {
      render();
      await openPicker();

      const btn = container.querySelector('[data-testid="delete-label-l1"]') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('删除标签');
      expect(btn.className).toContain('focus:opacity-100');
    });
  });
});
