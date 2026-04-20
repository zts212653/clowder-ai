/**
 * F080 + clowder-ai#314: Draft persistence across thread switches.
 *
 * Verifies that:
 * 1. Typed text survives unmount/remount with the same threadId
 * 2. Different threads maintain independent drafts
 * 3. Sending a message clears the draft
 * 4. Attached images survive thread remount, stay thread-scoped, and flow into onSend
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput, threadDrafts, threadImageDrafts } from '@/components/ChatInput';

// ── Mocks ──
vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/utils/compressImage', () => ({ compressImage: (f: File) => Promise.resolve(f) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶猫'],
        clientId: 'anthropic',
        defaultModel: 'opus',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

let container: HTMLDivElement;
let root: Root;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  threadDrafts.clear();
  threadImageDrafts.clear();
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name ?? 'image'}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function getFileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function getPreviewImage(name: string): HTMLImageElement | null {
  return container.querySelector(`img[alt="${name}"]`) as HTMLImageElement | null;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  // React controlled components need nativeInputValueSetter + input event
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  nativeSetter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeImageFile(name: string): File {
  return new File([`fake-${name}`], name, { type: 'image/png' });
}

async function attachFiles(files: File[]) {
  const input = getFileInput();
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: files,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('ChatInput draft persistence', () => {
  it('restores draft when remounting with same threadId', () => {
    const onSend = vi.fn();

    // Mount with thread-A, type something
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-A', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hello from A');
    });
    expect(getTextarea().value).toBe('hello from A');

    // Unmount
    act(() => root.unmount());

    // Remount with same threadId
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-A', onSend }));
    });

    // Draft should be restored
    expect(getTextarea().value).toBe('hello from A');
  });

  it('maintains independent drafts per thread', () => {
    const onSend = vi.fn();

    // Type in thread-A
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-A', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'draft A');
    });
    act(() => root.unmount());

    // Type in thread-B
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-B', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'draft B');
    });
    act(() => root.unmount());

    // Switch back to thread-A — should see "draft A", not "draft B"
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-A', onSend }));
    });
    expect(getTextarea().value).toBe('draft A');
  });

  it('clears draft after sending', () => {
    const onSend = vi.fn();

    // Type and send
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-C', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'will be sent');
    });

    // Press Enter to send
    const textarea = getTextarea();
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('will be sent', undefined, undefined, undefined);

    // Unmount and remount — draft should be gone
    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-C', onSend }));
    });
    expect(getTextarea().value).toBe('');
  });

  it('restores image preview when remounting with same threadId', async () => {
    const onSend = vi.fn();
    const fakeImage = makeImageFile('photo.png');

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IMG', onSend }));
    });
    await attachFiles([fakeImage]);
    expect(getPreviewImage('photo.png')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IMG', onSend }));
    });

    expect(getPreviewImage('photo.png')).toBeTruthy();
  });

  it('maintains independent image previews per thread across switches', async () => {
    const onSend = vi.fn();
    const imgA = makeImageFile('a.png');
    const imgB = makeImageFile('b.png');

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IA', onSend }));
    });
    await attachFiles([imgA]);
    expect(getPreviewImage('a.png')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IB', onSend }));
    });
    expect(getPreviewImage('a.png')).toBeNull();

    await attachFiles([imgB]);
    expect(getPreviewImage('b.png')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IA', onSend }));
    });
    expect(getPreviewImage('a.png')).toBeTruthy();
    expect(getPreviewImage('b.png')).toBeNull();
  });

  it('sends restored images and clears image drafts after sending', async () => {
    const onSend = vi.fn();
    const fakeImage = makeImageFile('pic.png');

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IS', onSend }));
    });
    await attachFiles([fakeImage]);
    expect(getPreviewImage('pic.png')).toBeTruthy();

    act(() => {
      typeInto(getTextarea(), 'msg with image');
    });

    act(() => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('msg with image', [fakeImage], undefined, undefined);
    expect(getPreviewImage('pic.png')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-IS', onSend }));
    });

    expect(getPreviewImage('pic.png')).toBeNull();
    expect(threadImageDrafts.has('thread-IS')).toBe(false);
  });

  it('evicts oldest image drafts when exceeding LRU limit', () => {
    const onSend = vi.fn();

    // Seed 5 image drafts (the max), then add a 6th before mounting
    for (let i = 1; i <= 5; i++) {
      threadImageDrafts.set(`thread-LRU-${i}`, [new File([`${i}`], `${i}.png`, { type: 'image/png' })]);
    }
    // Pre-seed 6th so useState initializer picks it up as images
    threadImageDrafts.set('thread-LRU-6', [new File(['6'], '6.png', { type: 'image/png' })]);
    expect(threadImageDrafts.size).toBe(6);

    // Mount thread-LRU-6 — images state initializes from draft map
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-LRU-6', onSend }));
    });
    // Type to trigger useLayoutEffect (images.length > 0 from init)
    act(() => {
      typeInto(getTextarea(), 'trigger');
    });
    act(() => root.unmount());

    // LRU eviction: max 5, oldest (thread-LRU-1) should be evicted
    expect(threadImageDrafts.size).toBeLessThanOrEqual(5);
    expect(threadImageDrafts.has('thread-LRU-1')).toBe(false);
    expect(threadImageDrafts.has('thread-LRU-6')).toBe(true);
  });

  it('does not persist draft when threadId is undefined', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'no thread');
    });

    // Map should remain empty — no threadId means no persistence
    expect(threadDrafts.size).toBe(0);
  });
});
