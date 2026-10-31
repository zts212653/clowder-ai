import type { ContextAttachment } from '@cat-cafe/shared';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRecoveredDraftImageUrl } from '@/components/durable-composer-draft-helpers';
import { threadImageDrafts } from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import type { OwnerComposerDraft } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { applyHomeCommand } from '../home-action-bridge';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const clientId = '11111111-1111-4111-8111-111111111111';
const clientToken = '22222222-2222-4222-8222-222222222222';
const token = '33333333-3333-4333-8333-333333333333';
const baseRoute = '/thread/source';
let setOwnerText: (text: string) => void;
let setOwnerContext: (values: ContextAttachment[]) => void;
let removeOwnerImage: (index: number) => void;
function Composer() {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [, setIsPreparingImages] = useState(false);
  const [contextAttachments, setContextAttachments] = useState<import('@cat-cafe/shared').ContextAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyToMessage = useChatStore((state) => state.replyToMessage);
  setOwnerText = setInput;
  setOwnerContext = setContextAttachments;
  const durable = useDurableComposerDraft({
    threadId: 'source',
    input,
    setInput,
    images,
    setImages,
    contextAttachments,
    setContextAttachments,
    replyToMessage,
    textareaRef,
    setIsPreparingImages,
  });
  removeOwnerImage = durable.removeImage;
  return (
    <>
      <textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value)} />
      <output data-testid="images">{images.map(getRecoveredDraftImageUrl).join(',')}</output>
      <output data-testid="context">{contextAttachments.map((value) => value.id).join(',')}</output>
      <output data-testid="reply">{replyToMessage?.id ?? ''}</output>
    </>
  );
}
const response = (body: unknown) => new Response(JSON.stringify(body));
const ports = () => ({
  token,
  clientId,
  clientToken,
  signal: new AbortController().signal,
  navigate: vi.fn(),
  captureBeforeSettings: vi.fn(),
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  window.history.replaceState({}, '', baseRoute);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  useChatStore.setState({ currentThreadId: 'source', pendingChatInsert: null, replyToMessage: null, threadStates: {} });
  threadImageDrafts.clear();
  vi.mocked(apiFetch).mockReset();
});

for (const change of [
  'remove image',
  'replace context',
  'remove reply',
  'change reply',
  'remove image during restoration',
])
  it(`preserves the owner's ${change} while the home command is pending, including durable state`, async () => {
    const attachment: ContextAttachment = { v: 1, id: 'before', kind: 'thread', threadId: 'source', title: 'Original' };
    const replacement: ContextAttachment = { ...attachment, id: 'after', title: 'Owner replacement' };
    const imageUrl = '/uploads/owner-draft.png';
    let draft: OwnerComposerDraft = {
      version: 1,
      ownerUserId: 'owner',
      threadId: 'source',
      revision: 1,
      text: '原有草稿',
      contentBlocks: [
        { type: 'image', url: imageUrl },
        { type: 'context_attachment', attachment },
      ],
      replyTo: 'original-reply',
      updatedAt: Date.now(),
    };
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let imageRequests = 0;
    let releaseImage!: () => void;
    let imageEntered!: () => void;
    const imagePending = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const imageStarted = new Promise<void>((resolve) => {
      imageEntered = resolve;
    });
    const paths: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      paths.push(path);
      if (path === imageUrl) {
        if (++imageRequests > 1 && change === 'remove image during restoration') {
          imageEntered();
          await imagePending;
        }
        return new Response(new Blob(['synthetic'], { type: 'image/png' }));
      }
      if (path.endsWith('/composer-draft')) {
        if (!init?.method || init.method === 'GET') return response({ draft, revision: draft.revision });
        const body = JSON.parse(String(init.body));
        expect(body.expectedRevision).toBe(draft.revision);
        draft = {
          version: 1,
          ownerUserId: 'owner',
          threadId: 'source',
          revision: draft.revision + 1,
          text: body.text,
          contentBlocks: body.contentBlocks,
          replyTo: body.replyTo,
          updatedAt: Date.now(),
        };
        return response({ draft });
      }
      if (path.startsWith('/api/concierge/home/commands/')) {
        const body = JSON.parse(String(init?.body));
        expect(body.expectedRevision).toBe(draft.revision);
        entered();
        await pending;
        draft = { ...draft, revision: draft.revision + 1, text: '原有草稿\n明天带伞' };
        return response({ kind: 'updated', clientId, baseRoute, expiresAt: Date.now() + 1_000, draft });
      }
      throw new Error('Unexpected owner route');
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Composer />);
      });
      expect(container.querySelector('[data-testid="images"]')?.textContent).toBe(imageUrl);
      expect(container.querySelector('[data-testid="context"]')?.textContent).toBe('before');
      expect(container.querySelector('[data-testid="reply"]')?.textContent).toBe('original-reply');
      const operation = applyHomeCommand(ports());
      await started;
      await act(async () => {
        setOwnerText('原有草稿，后来补充');
        if (change === 'remove image') removeOwnerImage(0);
        if (change === 'replace context') setOwnerContext([replacement]);
        if (change === 'remove reply') useChatStore.getState().clearReplyTo();
        if (change === 'change reply')
          useChatStore.getState().setReplyTo({
            id: 'owner-new-reply',
            content: 'Later quote',
            senderCatId: null,
            threadId: 'source',
          });
      });
      release();
      if (change === 'remove image during restoration') {
        await paint();
        await imageStarted;
        await act(async () => {
          removeOwnerImage(0);
        });
        releaseImage();
      }
      for (let i = 0; i < 70; i++) await paint();
      expect((await operation).status).toBe('applied');
      expect(container.querySelector('textarea')?.value).toBe('原有草稿\n明天带伞，后来补充');
      expect(container.querySelector('[data-testid="images"]')?.textContent).toBe(
        change.startsWith('remove image') ? '' : imageUrl,
      );
      expect(container.querySelector('[data-testid="context"]')?.textContent).toBe(
        change === 'replace context' ? 'after' : 'before',
      );
      const reply =
        change === 'remove reply' ? undefined : change === 'change reply' ? 'owner-new-reply' : 'original-reply';
      expect(container.querySelector('[data-testid="reply"]')?.textContent).toBe(reply ?? '');
      expect(draft.replyTo).toBe(reply);
      expect(draft.contentBlocks?.filter((block) => block.type === 'image').map((block) => block.url)).toEqual(
        change.startsWith('remove image') ? [] : [imageUrl],
      );
      expect(
        draft.contentBlocks?.filter((block) => block.type === 'context_attachment').map((block) => block.attachment.id),
      ).toEqual(change === 'replace context' ? ['after'] : ['before']);
      expect(paths.some((path) => path.includes('/messages'))).toBe(false);
    } finally {
      release();
      releaseImage();
      act(() => root.unmount());
      container.remove();
    }
  });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function paint() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
}

it('an expired or cancelled owner grant cannot navigate after its asynchronous response', async () => {
  for (const mode of ['expired', 'cancelled']) {
    const controller = new AbortController();
    vi.mocked(apiFetch).mockImplementation(async () => {
      if (mode === 'cancelled') controller.abort();
      return response({
        kind: 'navigate',
        clientId,
        baseRoute,
        expiresAt: Date.now() + (mode === 'expired' ? -1 : 1_000),
        action: { kind: 'settings', sectionId: 'plugins' },
      });
    });
    const input = { ...ports(), signal: controller.signal };
    expect((await applyHomeCommand(input)).status).toBe('blocked');
    expect(input.navigate).not.toHaveBeenCalled();
  }
});

it('a changed URL without the real Settings consumer DOM remains unconfirmed', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      kind: 'navigate',
      clientId,
      baseRoute,
      expiresAt: Date.now() + 80,
      action: { kind: 'settings', sectionId: 'plugins' },
    }),
  );
  const input = ports();
  input.navigate.mockImplementation((path) => {
    window.history.pushState({}, '', path);
  });
  const operation = applyHomeCommand(input);
  for (let i = 0; i < 8; i++) await paint();
  expect((await operation).status).toBe('unconfirmed');
});

it('the mounted canonical composer preserves concurrent local input, persists the merged draft, and never sends', async () => {
  let draft = {
    version: 1 as const,
    ownerUserId: 'owner',
    threadId: 'source',
    revision: 1,
    text: '原有草稿',
    updatedAt: Date.now(),
  };
  let grantBody: Record<string, unknown> | undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const paths: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    paths.push(path);
    if (path.endsWith('/composer-draft')) {
      if (!init?.method || init.method === 'GET') return response({ draft, revision: draft.revision });
      const body = JSON.parse(String(init.body));
      expect(body.expectedRevision).toBe(draft.revision);
      draft = { ...draft, revision: draft.revision + 1, text: body.text };
      return response({ draft });
    }
    if (path.startsWith('/api/concierge/home/commands/')) {
      grantBody = JSON.parse(String(init?.body));
      expect(grantBody?.expectedRevision).toBe(draft.revision);
      setOwnerText('原有草稿，后来补充');
      draft = { ...draft, revision: draft.revision + 1, text: '原有草稿\n明天带伞' };
      return response({ kind: 'updated', clientId, baseRoute, expiresAt: Date.now() + 1_000, draft });
    }
    throw new Error('Unexpected owner route');
  });
  try {
    await act(async () => {
      root.render(<Composer />);
    });
    const operation = applyHomeCommand(ports());
    for (let i = 0; i < 70; i++) await paint();
    expect(
      (await operation).status,
      JSON.stringify({ rendered: container.querySelector('textarea')?.value, draft, grantBody, paths }),
    ).toBe('applied');
    expect(container.querySelector('textarea')?.value).toBe('原有草稿\n明天带伞，后来补充');
    expect(draft.text).toBe('原有草稿\n明天带伞，后来补充');
    expect(grantBody?.clientToken).toBe(clientToken);
    expect(paths.some((path) => path.includes('/messages'))).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

for (const boundary of ['cancelled', 'expired', 'hidden'] as const) {
  it(`a committed draft response after ${boundary} is unconfirmed rather than falsely blocked`, async () => {
    const input = ports();
    const controller = new AbortController();
    vi.mocked(apiFetch).mockImplementation(async () => {
      if (boundary === 'cancelled') controller.abort();
      if (boundary === 'hidden')
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      return response({
        kind: 'updated',
        clientId,
        baseRoute,
        expiresAt: Date.now() + (boundary === 'expired' ? -1 : 1_000),
        draft: {
          version: 1,
          ownerUserId: 'owner',
          threadId: 'source',
          revision: 1,
          text: '已持久保存',
          updatedAt: Date.now(),
        },
      });
    });
    expect((await applyHomeCommand({ ...input, signal: controller.signal })).status).toBe('unconfirmed');
    expect(input.navigate).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });
}
