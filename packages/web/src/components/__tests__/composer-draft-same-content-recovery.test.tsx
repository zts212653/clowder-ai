import type { ContextAttachment } from '@cat-cafe/shared';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acknowledgeComposerDraftConsumption } from '@/components/composer-draft-consumption';
import { prepareComposerDraftAdmission } from '@/components/composer-draft-flush-registry';
import { threadContextAttachmentDrafts, threadImageDrafts } from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const THREAD = 'same-content-recovery-1657';
let root: Root;
let container: HTMLDivElement;
let owner: { text: string } | null;
let revision: number;
let writes: { text?: string; expectedRevision: number }[];
let typeText: (text: string) => void;
let beginAndClear: () => void;
let finish: (accepted: boolean) => void;
const preparing = () => {};
const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

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
    setIsPreparingImages: preparing,
  });
  typeText = setInput;
  beginAndClear = () => {
    finish = durable.beginAdmission({ text: input, images, contextAttachments: attachments, replyTo: null });
    durable.markOptimisticallyCleared();
    setInput('');
    setImages([]);
    setAttachments([]);
  };
  return <textarea ref={textareaRef} value={input} readOnly />;
}

async function settle() {
  await act(async () => {
    await Promise.all(Array.from({ length: 20 }, () => Promise.resolve()));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  threadImageDrafts.clear();
  threadContextAttachmentDrafts.clear();
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null, replyToMessage: null });
  owner = { text: 'old saved draft' };
  revision = 5;
  writes = [];
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (!init?.method) return response({ draft: owner, revision });
    const body = JSON.parse(String(init.body)) as { text?: string; expectedRevision: number };
    writes.push(body);
    expect(body.expectedRevision).toBe(revision);
    if (writes.length === 1) {
      owner = { text: body.text ?? '' }; // Another tab saved the very same content.
      revision += 1;
      return response({ error: 'revision_conflict' }, 409);
    }
    owner = init.method === 'DELETE' ? null : { text: body.text ?? '' };
    revision += 1;
    return response({ draft: owner, revision });
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

it.each([false, true])('resumes autosave after equal-content recovery admission, accepted=%s', async (accepted) => {
  await act(async () => root.render(<Harness />));
  await settle();
  expect(container.querySelector('textarea')?.value).toBe('old saved draft');
  act(() => typeText('same recovered content'));
  await act(async () => vi.advanceTimersByTimeAsync(401));
  await settle();
  expect(writes).toEqual([{ text: 'same recovered content', expectedRevision: 5 }]);
  expect(revision).toBe(6);

  act(() => beginAndClear());
  await act(async () => {
    expect(await prepareComposerDraftAdmission(THREAD)).toEqual({ threadId: THREAD, expectedRevision: 6 });
  });
  expect(writes).toHaveLength(1); // Equal content needs neither another PUT nor confirmation.
  act(() => {
    if (accepted) {
      owner = null;
      revision = 7;
      acknowledgeComposerDraftConsumption({ threadId: THREAD, expectedRevision: 6, revision });
    }
    finish(accepted);
  });
  await settle();
  act(() => typeText('next unsent edit must survive'));
  await act(async () => vi.advanceTimersByTimeAsync(401));
  await settle();
  expect(writes.at(-1)).toEqual({ text: 'next unsent edit must survive', expectedRevision: accepted ? 7 : 6 });
  expect(owner?.text).toBe('next unsent edit must survive');
});
