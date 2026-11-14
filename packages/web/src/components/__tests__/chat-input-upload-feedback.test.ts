// @vitest-environment jsdom
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { compressImage } from '@/utils/compressImage';

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({
  ImagePreview: () => null,
}));
vi.mock('@/utils/compressImage', () => ({
  compressImage: vi.fn((f: File) => Promise.resolve(f)),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const defaults = { onSend: vi.fn(), disabled: false };
  act(() => {
    root.render(React.createElement(ChatInput, { ...defaults, ...props }));
  });
}

describe('ChatInput upload feedback', () => {
  it('keeps uploading feedback inside the v2 composer even without thumbnails', () => {
    render({ presentation: 'v2', uploadStatus: 'uploading' });
    const frame = container.querySelector('[data-testid="chat-input-composer-row"]');
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('附件上传中，请稍候...');
    expect(frame?.contains(status)).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    const textarea = container.querySelector('textarea');
    assert(textarea);
    expect(status?.compareDocumentPosition(textarea)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the failed batch alert inside the v2 composer without thumbnails', () => {
    render({ presentation: 'v2', uploadStatus: 'failed', uploadError: '上传超时' });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('附件发送失败：上传超时');
    expect(container.querySelector('[data-testid="chat-input-composer-row"]')?.contains(alert)).toBe(true);
  });

  it('keeps classic upload feedback in its existing sibling position', () => {
    render({ presentation: 'classic', uploadStatus: 'uploading' });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('附件上传中，请稍候...');
    expect(container.querySelector('[data-testid="chat-input-composer-row"]')?.contains(status)).toBe(false);
  });

  it('reserves one extras row between a composer header and the textarea for status alone', () => {
    render({ presentation: 'v2', composerHeader: '正在运行', uploadStatus: 'uploading' });
    expect(container.querySelector('[data-testid="chat-composer-header"]')?.className).toContain('row-start-1');
    expect(container.querySelector('[data-testid="chat-composer-draft-extras"]')?.className).toContain('row-start-2');
    expect(container.querySelector('textarea')?.parentElement?.className).toContain('row-start-3');
  });

  it.each([
    { uploadStatus: 'idle' as const },
    { uploadStatus: 'failed' as const, uploadError: null },
  ])('does not reserve an empty extras row for $uploadStatus without visible feedback', (props) => {
    render({ presentation: 'v2', ...props });
    expect(container.querySelector('[data-testid="chat-composer-draft-extras"]')).toBeNull();
  });

  it('keeps preparation, real thumbnails and post-send upload feedback in the same v2 attachment area', async () => {
    let finishPreparation: ((file: File) => void) | undefined;
    vi.mocked(compressImage).mockReturnValueOnce(new Promise<File>((resolve) => (finishPreparation = resolve)));
    const onSend = vi.fn();
    render({ presentation: 'v2', onSend });
    const image = new File(['image'], 'preview.png', { type: 'image/png' });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    assert(fileInput);
    Object.defineProperty(fileInput, 'files', { value: [image] });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    const frame = container.querySelector('[data-testid="chat-input-composer-row"]');
    assert(frame);
    const preparing = container.querySelector('[role="status"]');
    expect(preparing?.textContent).toContain('附件处理中，完成后可发送');
    expect(frame.contains(preparing)).toBe(true);
    await act(async () => {
      assert(finishPreparation);
      finishPreparation(image);
    });
    const thumbnail = frame.querySelector('img[alt="preview.png"]');
    expect(thumbnail?.getAttribute('src')).toBe('blob:preview');
    expect(frame.querySelector('[role="status"]')).toBeNull();
    const remove = frame.querySelector<HTMLButtonElement>('[aria-label="Remove preview.png"]');
    assert(remove);
    act(() => remove.click());
    expect(frame.querySelector('img')).toBeNull();
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    const textarea = container.querySelector('textarea');
    assert(textarea);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '看图');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('看图', [image], undefined, undefined);
    expect(frame.querySelector('img')).toBeNull();
    render({ presentation: 'v2', onSend, uploadStatus: 'uploading' });
    expect(container.querySelector('[data-testid="chat-input-composer-row"] [role="status"]')?.textContent).toContain(
      '附件上传中，请稍候...',
    );
  });
});
