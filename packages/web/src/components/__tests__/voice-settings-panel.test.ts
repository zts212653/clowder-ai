import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';

// Stub localStorage before importing the component
const mockStorage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  }),
  get length() {
    return Object.keys(mockStorage).length;
  },
  key: vi.fn(() => null),
});

// Dynamic import after mocks are set up
const { VoiceSettingsPanel } = await import('@/components/VoiceSettingsPanel');

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  vi.clearAllMocks();
  useVoiceSettingsStore.setState({
    settings: { customTerms: [], customPrompt: null, language: 'zh' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPanel() {
  act(() => {
    root.render(React.createElement(VoiceSettingsPanel));
  });
}

function getInputs(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="text"]'));
}

function getButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function fireKeyDown(el: HTMLElement, key: string, extra: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...extra });
  el.dispatchEvent(event);
}

function fireKeyDownComposing(el: HTMLElement, key: string) {
  // Simulate Enter during IME composition: compositionstart → keydown
  el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

// ─── AddTermRow: IME composition guard ───

describe('AddTermRow IME composition guard', () => {
  it('adds term on Enter when not composing', () => {
    renderPanel();
    const inputs = getInputs();
    const fromInput = inputs[0];
    const toInput = inputs[1];

    act(() => {
      // Simulate typing via React-compatible input events
      fireNativeInput(fromInput, 'GPT');
      fireNativeInput(toInput, 'GPT');
    });

    act(() => {
      fireKeyDown(toInput, 'Enter');
    });

    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([{ from: 'GPT', to: 'GPT' }]);
  });

  it('does NOT add term on Enter when IME is composing', () => {
    renderPanel();
    const inputs = getInputs();
    const fromInput = inputs[0];
    const toInput = inputs[1];

    act(() => {
      fireNativeInput(fromInput, 'GPT');
      fireNativeInput(toInput, 'GPT');
    });

    act(() => {
      fireKeyDownComposing(toInput, 'Enter');
    });

    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([]);
  });

  it('focuses second input on Enter in first input when to-field is empty', () => {
    renderPanel();
    const inputs = getInputs();
    const fromInput = inputs[0];
    const toInput = inputs[1];

    act(() => {
      fireNativeInput(fromInput, 'GPT');
    });

    act(() => {
      fireKeyDown(fromInput, 'Enter');
    });

    expect(document.activeElement).toBe(toInput);
  });
});

// ─── CustomTermRow: inline editing ───

describe('CustomTermRow inline editing', () => {
  function seedTerm(from: string, to: string) {
    useVoiceSettingsStore.getState().addTerm(from, to);
  }

  it('enters edit mode on edit button click', () => {
    seedTerm('gpt', 'GPT');
    renderPanel();

    const editBtn = getButtons().find((b) => b.title === '编辑');
    expect(editBtn).toBeDefined();

    act(() => {
      editBtn?.click();
    });

    // In edit mode, there should be 4 inputs: 2 for edit row + 2 for add row
    const inputs = getInputs();
    expect(inputs.length).toBe(4);
    // First two are the edit inputs, pre-filled with term values
    expect(inputs[0].value).toBe('gpt');
    expect(inputs[1].value).toBe('GPT');
  });

  it('saves edit on Enter (non-composing)', () => {
    seedTerm('gpt', 'GPT');
    renderPanel();

    const editBtn = getButtons().find((b) => b.title === '编辑');
    act(() => {
      editBtn?.click();
    });

    const inputs = getInputs();
    act(() => {
      fireNativeInput(inputs[0], 'chatgpt');
      fireNativeInput(inputs[1], 'ChatGPT');
    });

    act(() => {
      fireKeyDown(inputs[1], 'Enter');
    });

    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([{ from: 'chatgpt', to: 'ChatGPT' }]);
  });

  it('does NOT save on Enter when IME is composing', () => {
    seedTerm('gpt', 'GPT');
    renderPanel();

    const editBtn = getButtons().find((b) => b.title === '编辑');
    act(() => {
      editBtn?.click();
    });

    const inputs = getInputs();
    act(() => {
      fireNativeInput(inputs[0], 'changed');
    });

    act(() => {
      fireKeyDownComposing(inputs[0], 'Enter');
    });

    // Should still be in edit mode (4 inputs), term unchanged
    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([{ from: 'gpt', to: 'GPT' }]);
  });

  it('cancels edit on Escape without saving', () => {
    seedTerm('gpt', 'GPT');
    renderPanel();

    const editBtn = getButtons().find((b) => b.title === '编辑');
    act(() => {
      editBtn?.click();
    });

    const inputs = getInputs();
    act(() => {
      fireNativeInput(inputs[0], 'CHANGED');
    });

    act(() => {
      fireKeyDown(inputs[0], 'Escape');
    });

    // Term should be unchanged
    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([{ from: 'gpt', to: 'GPT' }]);

    // Should exit edit mode (back to 2 inputs for add row)
    expect(getInputs().length).toBe(2);
  });
});

// ─── CustomTermRow: delete button ───

describe('CustomTermRow delete button', () => {
  it('delete button is always visible (not hover-only)', () => {
    useVoiceSettingsStore.getState().addTerm('test', 'TEST');
    renderPanel();

    const deleteBtn = getButtons().find((b) => b.title === '删除');
    expect(deleteBtn).toBeDefined();

    // Should NOT have opacity-0 class (which makes it invisible without hover)
    expect(deleteBtn?.className).not.toContain('opacity-0');
  });

  it('removes term on delete click', () => {
    useVoiceSettingsStore.getState().addTerm('test', 'TEST');
    renderPanel();

    const deleteBtn = getButtons().find((b) => b.title === '删除');
    act(() => {
      deleteBtn?.click();
    });

    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([]);
  });
});

// ─── Helper: simulate controlled input value change ───

function fireNativeInput(input: HTMLInputElement, value: string) {
  // For React controlled components rendered via createRoot, we need to
  // set the value via the native setter and dispatch an input event.
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
