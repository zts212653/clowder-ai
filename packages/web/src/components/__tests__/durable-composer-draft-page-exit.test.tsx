import 'fake-indexeddb/auto';
import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acknowledgeComposerDraftConsumption,
  recoverMountedComposerDraft,
} from '@/components/composer-draft-consumption';
import { writeOwnerComposerDraft } from '@/components/durable-composer-draft-helpers';
import { syncContextAttachmentDraftToStorage, threadContextAttachmentDrafts } from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import {
  editWorkspaceFileQuoteInChat,
  workspaceFileQuoteAttachment,
} from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import {
  findSendAttempt,
  observeCanceledSendAttempts,
  putSendAttempt,
  useSendAttemptStore,
} from '@/stores/send-attempt-store';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { deleteSendAttempt, loadSendAttempts, saveSendAttempt } from '@/utils/send-attempt-db';
import { composerInsertFromRecall } from '@/utils/true-recall';

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
let owner: { text: string; contentBlocks?: MessageContent[] } | null;
let writes: RequestInit[];
let revision: number;
let settleAdmission: (accepted: boolean | undefined) => void;
let clearInput: () => void;
let typeNewInput: (text: string) => void;
let removeRecoveredFile: (index: number) => void;
let discardUnrestoredFiles: () => Promise<void>;
const setIsPreparingImages = () => {};

function Harness({ threadId = THREAD }: { threadId?: string } = {}) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [attachments, setAttachments] = useState<ContextAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const durable = useDurableComposerDraft({
    threadId,
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
  removeRecoveredFile = durable.removeImage;
  discardUnrestoredFiles = durable.discardUnrestoredImages;
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
      <span data-testid="images">{images.length}</span>
      <span data-testid="unrestored">{durable.unrestoredImageCount}</span>
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

it('HTTP recall inserts a visible ordinary file and removing it removes its durable reference', async () => {
  vi.useRealTimers();
  observeApiSessionOwner('http-file-owner');
  await render();
  const fileBlock = {
    type: 'file' as const,
    url: '/uploads/http-note.txt',
    fileName: 'http-note.txt',
    mimeType: 'text/plain',
    fileSize: 4,
  };
  const originalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url) === fileBlock.url
      ? Promise.resolve(new Response('note', { headers: { 'Content-Type': 'text/plain' } }))
      : originalFetch(url, init),
  );
  revision = 70;
  const insert = composerInsertFromRecall({
    verdict: 'already_recalled',
    message: { id: 'http-recalled', threadId: THREAD, recall: { version: 1, exposure: 'none', recalledAt: 1 } },
    draft: {
      version: 1,
      ownerUserId: 'http-file-owner',
      threadId: THREAD,
      revision,
      text: 'http recalled file',
      contentBlocks: [fileBlock],
      updatedAt: 1,
    },
    insertedRange: null,
    queue: [],
  });
  await act(async () => useChatStore.getState().setPendingChatInsert(insert));
  await settle();
  expect(container.querySelector('[data-testid="images"]')?.textContent).toBe('1');
  await act(async () => removeRecoveredFile(0));
  window.dispatchEvent(new Event('pagehide'));
  await settle();
  const last = writes.at(-1);
  expect(last?.method).toBe('PUT');
  expect(JSON.parse(String(last?.body)).contentBlocks ?? []).not.toContainEqual(fileBlock);
});

it('does not roll an old owner file reference back after a failed explicit discard completes late', async () => {
  vi.useRealTimers();
  observeApiSessionOwner('discard-file-owner');
  const originalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  owner = {
    text: 'old file draft',
    contentBlocks: [
      { type: 'context_attachment', attachment: quote },
      {
        type: 'file',
        url: '/uploads/unavailable.txt',
        fileName: 'unavailable.txt',
        mimeType: 'text/plain',
        fileSize: 4,
      },
    ],
  };
  let finishDiscard!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation((url, init) => {
    if (String(url) === '/uploads/unavailable.txt') return Promise.resolve(new Response('{}', { status: 503 }));
    if (init?.method === 'PUT')
      return new Promise<Response>((resolve) => {
        finishDiscard = resolve;
      });
    return originalFetch(url, init);
  });
  await render();
  expect(container.querySelector('[data-testid="unrestored"]')?.textContent).toBe('1');
  let discarded!: Promise<void>;
  await act(async () => {
    discarded = discardUnrestoredFiles();
  });
  await settle();
  expect(finishDiscard).toBeTypeOf('function');
  await act(async () => {
    observeApiSessionOwner('discard-new-owner');
    typeNewInput('new account typing');
  });
  vi.mocked(apiFetch).mockImplementation(originalFetch);
  await act(async () => {
    finishDiscard(new Response('{}', { status: 503 }));
    await discarded;
  });
  expect(container.querySelector('textarea')?.value).toBe('new account typing');
  expect(container.querySelector('[data-testid="unrestored"]')?.textContent).toBe('0');
});

it.each([
  ['account', 'image'],
  ['thread', 'image'],
  ['account', 'file'],
  ['thread', 'file'],
])('abandons late recalled %s owner changes for %s bytes', async (change, kind) => {
  vi.useRealTimers();
  observeApiSessionOwner('late-image-owner');
  await render();
  const originalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  let finishImage!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    String(url) === '/uploads/late-recall.png'
      ? new Promise<Response>((resolve) => {
          finishImage = resolve;
        })
      : originalFetch(url, init),
  );
  let recovery!: Promise<boolean>;
  await act(async () => {
    recovery = recoverMountedComposerDraft({
      version: 1,
      ownerUserId: 'late-image-owner',
      threadId: THREAD,
      revision: 70,
      text: 'old recalled body',
      contentBlocks: [
        kind === 'file'
          ? {
              type: 'file',
              url: '/uploads/late-recall.png',
              fileName: 'late.txt',
              mimeType: 'text/plain',
              fileSize: 16,
            }
          : { type: 'image', url: '/uploads/late-recall.png' },
      ],
      updatedAt: 1,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
  expect(finishImage).toBeTypeOf('function');
  await act(async () => {
    if (change === 'account') observeApiSessionOwner('new-image-owner');
    else root.render(<Harness threadId="new-image-thread" />);
  });
  await settle();
  await act(async () => typeNewInput('new owner input'));
  await act(async () => {
    finishImage(new Response(new Blob(['late image bytes'], { type: 'image/png' })));
    expect(await recovery).toBe(false);
  });
  expect(container.querySelector('textarea')?.value).toBe('new owner input');
  expect(container.querySelector('[data-testid="images"]')?.textContent).toBe('0');
});

it('recovers an event-only recall through the mounted draft owner without erasing newly typed text', async () => {
  vi.useRealTimers();
  observeApiSessionOwner('recall-owner');
  useSendAttemptStore.setState({ attempts: [] });
  await render();
  const attempt = {
    id: 'event-only-recall',
    ownerUserId: 'recall-owner',
    threadId: THREAD,
    content: '撤回原文',
    files: [],
    timestamp: 1,
    status: 'accepted' as const,
    serverMessageId: 'recall-source',
    composerDraftRevision: 68,
  };
  await saveSendAttempt(attempt);
  putSendAttempt(attempt);
  act(() => typeNewInput('原聊天草稿 + 新输入'));
  const newReply = { id: 'new-reply', content: 'new reply', senderCatId: null, threadId: THREAD };
  useChatStore.getState().setReplyTo(newReply);
  owner = { text: '原聊天草稿\n\n撤回原文', contentBlocks: [{ type: 'context_attachment', attachment: quote }] };
  revision = 70;
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        draft: {
          ...owner,
          version: 1,
          ownerUserId: 'recall-owner',
          threadId: THREAD,
          revision,
          updatedAt: 1,
          replyTo: 'old-reply',
        },
        revision,
      }),
    ),
  );
  await act(async () => observeCanceledSendAttempts(THREAD, ['recall-source'], 'recalled'));
  await settle();
  expect(container.querySelector('textarea')?.value).toContain('撤回原文');
  expect(container.querySelector('textarea')?.value).toContain('+ 新输入');
  expect(container.querySelector('[data-testid="quotes"]')?.textContent).toBe('1');
  expect(useChatStore.getState().replyToMessage?.id).toBe('new-reply');
  expect(findSendAttempt(attempt.ownerUserId, THREAD, attempt.id)).toBeUndefined();
  expect(await loadSendAttempts(attempt.ownerUserId, THREAD)).toEqual([]);
  expect(writes.every((write) => write.method !== 'POST')).toBe(true);
  const recovered = container.querySelector('textarea')?.value;
  await act(async () =>
    useChatStore.getState().setPendingChatInsert({
      threadId: THREAD,
      text: '原聊天草稿\n\n撤回原文',
      serverRevision: 70,
      authoritative: true,
      clientSnapshot: { text: '原聊天草稿', contextAttachments: [] },
    }),
  );
  expect(container.querySelector('textarea')?.value).toBe(recovered);
  await act(async () => observeCanceledSendAttempts(THREAD, ['recall-source'], 'recalled'));
  expect(container.querySelector('textarea')?.value).toBe(recovered);
  await deleteSendAttempt(attempt);
});

it('acknowledges an HTTP-restored recall revision without merging it a second time', async () => {
  observeApiSessionOwner('recall-owner');
  await render();
  await act(async () =>
    useChatStore.getState().setPendingChatInsert({
      threadId: THREAD,
      text: 'HTTP restored recall',
      serverRevision: 70,
      authoritative: true,
    }),
  );
  await act(async () =>
    expect(
      await recoverMountedComposerDraft({
        version: 1,
        ownerUserId: 'recall-owner',
        threadId: THREAD,
        revision: 70,
        text: 'HTTP restored recall',
        updatedAt: 1,
      }),
    ).toBe(true),
  );
  expect(container.querySelector('textarea')?.value).toBe('HTTP restored recall');
});

it.each([
  'account',
  'unmount',
])('waits for initial hydration and abandons recall recovery after %s changes', async (change) => {
  observeApiSessionOwner('recall-owner');
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise<Response>((finish) => {
        resolve = finish;
      }),
  );
  await act(async () => root.render(<Harness />));
  const recovery = recoverMountedComposerDraft({
    version: 1,
    ownerUserId: 'recall-owner',
    threadId: THREAD,
    revision: 70,
    text: 'recall after hydration',
    updatedAt: 1,
  });
  if (change === 'account') observeApiSessionOwner('other-owner');
  else await act(async () => root.render(<div />));
  await act(async () => resolve(new Response(JSON.stringify({ draft: null, revision: 69 }))));
  expect(await recovery).toBe(false);
  if (change === 'unmount') expect(container.querySelector('textarea')).toBeNull();
  else expect(container.querySelector('textarea')?.value).not.toContain('recall after hydration');
});

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
  expect(owner?.contentBlocks?.find((block) => block.type === 'context_attachment')?.attachment).toEqual(quote);
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
  expect(owner?.contentBlocks?.find((block) => block.type === 'context_attachment')?.attachment).toEqual(quote);
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
