import type { ContextAttachment } from '@cat-cafe/shared';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acknowledgeComposerDraftConsumption } from '@/components/composer-draft-consumption';
import { writeOwnerComposerDraft } from '@/components/durable-composer-draft-helpers';
import { syncContextAttachmentDraftToStorage, threadContextAttachmentDrafts } from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import {
  editWorkspaceFileQuoteInChat,
  workspaceFileQuoteAttachment,
} from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const THREAD = 'draft-page-exit';
const quote = workspaceFileQuoteAttachment({
  text: '窗边',
  comment: '原说明',
  path: 'docs/a.md',
  revision: 'a'.repeat(64),
});
let root: Root;
let container: HTMLDivElement;
let owner: { text: string; contentBlocks?: { type: 'context_attachment'; attachment: ContextAttachment }[] } | null;
let writes: RequestInit[];
let revision: number;
let settleAdmission: (accepted: boolean | undefined) => void;
let clearInput: () => void;
let typeNewInput: (text: string) => void;
const setIsPreparingImages = () => {};

function Harness() {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [attachments, setAttachments] = useState<ContextAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const durable = useDurableComposerDraft({
    threadId: THREAD,
    input,
    setInput,
    images,
    setImages,
    contextAttachments: attachments,
    setContextAttachments: setAttachments,
    replyToMessage: null,
    textareaRef,
    setIsPreparingImages,
  });
  typeNewInput = setInput;
  clearInput = () => {
    settleAdmission = durable.beginAdmission({ text: input, images, contextAttachments: attachments, replyTo: null });
    durable.markOptimisticallyCleared();
    setInput('');
    setAttachments([]);
    setImages([]);
  };
  return (
    <>
      <textarea ref={textareaRef} value={input} readOnly />
      <span data-testid="quotes">{attachments.length}</span>
    </>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  threadContextAttachmentDrafts.clear();
  syncContextAttachmentDraftToStorage(THREAD, [quote]);
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null, replyToMessage: null });
  writes = [];
  revision = 69;
  owner = { text: '原聊天草稿', contentBlocks: [{ type: 'context_attachment', attachment: quote }] };
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method) {
      writes.push(init);
      const command = JSON.parse(String(init.body));
      expect(command.expectedRevision).toBe(revision);
      owner = init.method === 'DELETE' ? null : { text: command.text, contentBlocks: command.contentBlocks };
      revision += 1;
    }
    return { ok: true, status: 200, json: async () => ({ draft: owner, revision }) } as Response;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  await settle();
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render() {
  await act(async () => root.render(<Harness />));
  await settle();
  expect(container.querySelector('[data-testid="quotes"]')?.textContent).toBe('1');
}

it('flushes file-side deletion on page exit without waiting for the typing debounce', async () => {
  await render();
  act(() => {
    expect(quote.kind).toBe('quote');
    if (quote.kind === 'quote') expect(editWorkspaceFileQuoteInChat(THREAD, quote, null)).toBe(true);
  });
  await settle();
  expect(container.querySelector('[data-testid="quotes"]')?.textContent).toBe('0');
  expect(writes).toEqual([]);
  act(() => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.keepalive).toBe(true);
  expect(JSON.parse(String(writes[0]?.body)).expectedRevision).toBe(69);
  expect(owner).toEqual({ text: '原聊天草稿', contentBlocks: undefined });
});

it('captures a file-side deletion when pagehide precedes the composer React commit', async () => {
  await render();
  act(() => {
    if (quote.kind !== 'quote') throw new Error('expected a file quote');
    expect(editWorkspaceFileQuoteInChat(THREAD, quote, null)).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
  });
  await settle();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.keepalive).toBe(true);
  expect(owner).toEqual({ text: '原聊天草稿', contentBlocks: undefined });
});

it('does not repeat an accepted clear when pagehide follows its immediate owner write', async () => {
  await render();
  act(() => clearInput());
  act(() => settleAdmission(undefined));
  await settle();
  expect(writes.map((write) => write.method)).toEqual(['DELETE']);
  act(() => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(writes.map((write) => write.method)).toEqual(['DELETE']);
  expect(writes[0]?.keepalive).toBe(true);
  expect(owner).toBeNull();
});

it('uses keepalive for a small draft and ordinary transport for oversized ASCII or UTF-8 bodies', async () => {
  for (const text of ['small', 'x'.repeat(70_000), '字'.repeat(24_000)]) {
    await writeOwnerComposerDraft(THREAD, revision, {
      text,
      imageUrls: [],
      contextAttachments: [],
      preservedBlocks: [],
    });
  }
  expect(writes.map((write) => write.keepalive === true)).toEqual([true, false, false]);
  expect(new Blob([String(writes[1]?.body)]).size).toBeGreaterThan(64 * 1024);
  expect(new Blob([String(writes[2]?.body)]).size).toBeGreaterThan(64 * 1024);
});

it('pagehide flushes typing on the debounce as one keepalive PUT with the new text', async () => {
  await render();
  act(() => typeNewInput('刚打的字\nnot yet saved'));
  await settle();
  expect(writes).toEqual([]);
  act(() => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(writes.map((write) => write.method)).toEqual(['PUT']);
  expect(writes[0]?.keepalive).toBe(true);
  expect(JSON.parse(String(writes[0]?.body)).text).toBe('刚打的字\nnot yet saved');
  expect(owner?.contentBlocks?.[0]?.attachment).toEqual(quote);
});

it('writes the successful admission clear before the autosave timer or a page-exit event', async () => {
  await render();
  act(() => clearInput());
  act(() => settleAdmission(undefined));
  await settle();
  expect(writes.map((write) => write.method)).toEqual(['DELETE']);
  expect(owner).toBeNull();
});

it('keeps a rejected admission draft without committing the optimistic clear', async () => {
  await render();
  act(() => clearInput());
  await settle();
  act(() => settleAdmission(false));
  await settle();
  expect(container.querySelector('textarea')?.value).toBe('原聊天草稿');
  expect(container.querySelector('[data-testid="quotes"]')?.textContent).toBe('1');
  expect(owner?.contentBlocks?.[0]?.attachment).toEqual(quote);
  expect(writes).toEqual([]);
});

it('keeps new typing while an earlier send is pending and saves it without the sent quote', async () => {
  await render();
  act(() => clearInput());
  act(() => typeNewInput('下一条草稿\nkeep this'));
  await settle();
  expect(writes).toEqual([]);
  act(() => settleAdmission(undefined));
  await settle();
  expect(owner).toEqual({ text: '下一条草稿\nkeep this', contentBlocks: undefined });
  expect(writes.map((write) => write.method)).toEqual(['PUT']);
});

it('saves new typing against the consumed owner revision after a server-side accepted clear', async () => {
  await render();
  act(() => clearInput());
  act(() => typeNewInput('下一条草稿\nkeep this'));
  await settle();
  owner = null;
  revision = 70;
  act(() => {
    acknowledgeComposerDraftConsumption({ threadId: THREAD, expectedRevision: 69, revision: 70 });
    settleAdmission(undefined);
  });
  await settle();
  expect(owner).toEqual({ text: '下一条草稿\nkeep this', contentBlocks: undefined });
  expect(writes.map((write) => write.method)).toEqual(['PUT']);
  expect(JSON.parse(String(writes[0]?.body)).expectedRevision).toBe(70);
});

it('does not repeat a server-side consumed clear or resurrect its sent quote', async () => {
  await render();
  act(() => clearInput());
  owner = null;
  revision = 70;
  act(() => {
    acknowledgeComposerDraftConsumption({ threadId: THREAD, expectedRevision: 69, revision: 70 });
    settleAdmission(undefined);
    window.dispatchEvent(new Event('pagehide'));
  });
  await settle();
  expect(writes).toEqual([]);
  expect(owner).toBeNull();
  expect(container.querySelector('[data-testid="quotes"]')?.textContent).toBe('0');
});

it('ignores a stale or malformed consumption receipt instead of changing the current owner revision', async () => {
  await render();
  act(() => {
    acknowledgeComposerDraftConsumption({ threadId: THREAD, expectedRevision: 67, revision: 68 });
    acknowledgeComposerDraftConsumption({ threadId: THREAD, expectedRevision: 69, revision: 90 });
    typeNewInput('仍在当前代次编辑');
  });
  act(() => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(owner?.text).toBe('仍在当前代次编辑');
  expect(JSON.parse(String(writes[0]?.body)).expectedRevision).toBe(69);
});
