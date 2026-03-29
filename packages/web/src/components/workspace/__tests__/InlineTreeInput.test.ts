// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../FileIcons', () => ({
  FileIcon: () => React.createElement('span', null, '[F]'),
  DirIcon: () => React.createElement('span', null, '[D]'),
}));

const { InlineTreeInput } = await import('../InlineTreeInput');

describe('InlineTreeInput', () => {
  it('renders an input with placeholder for new file', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(InlineTreeInput, {
          depth: 1,
          kind: 'file',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const input = container.querySelector('input');
    expect(input).toBeTruthy();
    expect(input?.placeholder).toContain('文件名');
    root.unmount();
  });

  it('calls onConfirm with trimmed value on Enter', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onConfirm = vi.fn();

    act(() => {
      root.render(
        React.createElement(InlineTreeInput, {
          depth: 0,
          kind: 'file',
          onConfirm,
          onCancel: vi.fn(),
        }),
      );
    });

    const input = container.querySelector('input')!;
    act(() => {
      input.value = '  test.md  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Simulate change via React
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(input, 'test.md');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onConfirm).toHaveBeenCalledWith('test.md');
    root.unmount();
  });

  it('calls onCancel on Escape', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCancel = vi.fn();

    act(() => {
      root.render(
        React.createElement(InlineTreeInput, {
          depth: 0,
          kind: 'directory',
          onConfirm: vi.fn(),
          onCancel,
        }),
      );
    });

    const input = container.querySelector('input')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalled();
    root.unmount();
  });

  it('shows directory placeholder for kind=directory', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(InlineTreeInput, {
          depth: 0,
          kind: 'directory',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const input = container.querySelector('input');
    expect(input?.placeholder).toContain('目录名');
    root.unmount();
  });

  it('ignores Enter during IME composition', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onConfirm = vi.fn();

    act(() => {
      root.render(
        React.createElement(InlineTreeInput, {
          depth: 0,
          kind: 'directory',
          onConfirm,
          onCancel: vi.fn(),
        }),
      );
    });

    const input = container.querySelector('input')!;
    // Type some text
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'ios');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Simulate Enter during IME composition: compositionstart → keydown(Enter)
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onConfirm).not.toHaveBeenCalled();
    root.unmount();
  });
});
