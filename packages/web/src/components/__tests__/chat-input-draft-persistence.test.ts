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
import {
  ChatInput,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/ChatInput';
import { parseContextAttachmentDrafts } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { requestTrueRecall } from '@/utils/true-recall';

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
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'ME',
    aliases: [],
    mentionPatterns: ['@co-creator'],
    color: { primary: '#D4A76A', secondary: '#FFF8F0' },
  }),
}));
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function apiResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(),
  } as Response;
}

beforeEach(() => {
  threadDrafts.clear();
  threadImageDrafts.clear();
  threadReplyDrafts.clear();
  threadContextAttachmentDrafts.clear();
  window.sessionStorage.removeItem('cat-cafe:thread-context-attachment-drafts');
  useChatStore.setState({
    currentThreadId: 'default',
    hasDraft: false,
    threadStates: {},
    pendingChatInsert: null,
    replyToMessage: null,
  });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (typeof url === 'string' && url.endsWith('/composer-draft')) {
      if (!init || init.method === 'GET') return apiResponse({ draft: null, revision: 0 });
      if (init.method === 'DELETE') {
        const request = JSON.parse(String(init.body)) as { expectedRevision: number };
        return apiResponse({ cleared: true, revision: request.expectedRevision + 1 });
      }
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text: string };
      return apiResponse({
        draft: {
          version: 1,
          ownerUserId: 'u1',
          threadId: url.split('/')[3],
          revision: request.expectedRevision + 1,
          text: request.text,
          updatedAt: Date.now(),
        },
      });
    }
    return apiResponse({});
  });
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
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it('hydrates saved reply drafts before mount-time persistence can clear them', () => {
    const onSend = vi.fn();
    const savedReply = {
      id: 'msg-parent',
      content: 'quoted parent',
      senderCatId: 'opus',
      threadId: 'thread-REPLY',
    };
    threadReplyDrafts.set('thread-REPLY', savedReply);

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-REPLY', onSend }));
    });

    expect(useChatStore.getState().replyToMessage).toEqual(savedReply);
    expect(threadReplyDrafts.get('thread-REPLY')).toEqual(savedReply);
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
    expect(onSend).toHaveBeenCalledWith('will be sent', undefined, undefined, undefined, undefined, undefined);

    // Unmount and remount — draft should be gone
    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-C', onSend }));
    });
    expect(getTextarea().value).toBe('');
  });

  it('consumes pending chat insert into the matching thread composer', async () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-RECALL', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'current draft');
    });

    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-RECALL',
        text: 'recalled queued message',
      });
      await Promise.resolve();
    });

    expect(getTextarea().value).toBe('current draft\nrecalled queued message');
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it.each([
    {
      producer: 'Workspace file',
      attachment: {
        v: 1 as const,
        id: 'ctx-workspace-file-focus',
        kind: 'workspace_file' as const,
        path: 'docs/focus.md',
        worktreeId: 'main',
      },
    },
    {
      producer: 'Workspace quote',
      attachment: {
        v: 1 as const,
        id: 'ctx-workspace-quote-focus',
        kind: 'quote' as const,
        text: 'workspace selection',
        source: {
          kind: 'workspace_file' as const,
          path: 'docs/focus.md',
          worktreeId: 'main',
        },
      },
    },
    {
      producer: 'Message quote',
      attachment: {
        v: 1 as const,
        id: 'ctx-message-quote-focus',
        kind: 'quote' as const,
        text: 'message selection',
        source: {
          kind: 'message' as const,
          threadId: 'thread-FOCUS',
          messageId: 'msg-focus',
        },
      },
    },
    {
      producer: 'CLI Output quote',
      attachment: {
        v: 1 as const,
        id: 'ctx-cli-quote-focus',
        kind: 'quote' as const,
        text: 'cli selection',
        source: {
          kind: 'cli_output' as const,
          threadId: 'thread-FOCUS',
          messageId: 'msg-cli-focus',
        },
      },
    },
  ])('focuses the composer at the existing draft end after consuming a $producer attachment', async ({
    attachment,
  }) => {
    const onSend = vi.fn();
    const existingAttachment = {
      v: 1 as const,
      id: 'ctx-existing-focus',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Existing context',
    };
    threadDrafts.set('thread-FOCUS', 'existing draft');
    threadContextAttachmentDrafts.set('thread-FOCUS', [existingAttachment]);

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-FOCUS', onSend }));
    });
    const outsideTarget = document.createElement('button');
    document.body.appendChild(outsideTarget);
    outsideTarget.focus();
    expect(document.activeElement).toBe(outsideTarget);

    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-FOCUS',
        text: '',
        contextAttachments: [attachment],
      });
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const textarea = getTextarea();
    expect(document.activeElement).toBe(textarea);
    outsideTarget.remove();
    expect(textarea.value).toBe('existing draft');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
    expect(threadContextAttachmentDrafts.get('thread-FOCUS')).toHaveLength(2);
    expect(threadContextAttachmentDrafts.get('thread-FOCUS')).toEqual(
      expect.arrayContaining([existingAttachment, attachment]),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('restores and sends structured context attachments without Markdown text', async () => {
    const onSend = vi.fn();
    const attachment = {
      v: 1 as const,
      id: 'ctx-thread-draft',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Source Thread',
    };

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-CONTEXT', onSend }));
    });
    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-CONTEXT',
        text: '',
        contextAttachments: [attachment],
      });
      await Promise.resolve();
    });

    expect(getTextarea().value).toBe('');
    expect(container.querySelector('[data-context-kind="thread"]')?.textContent).toContain('Source Thread');
    expect(threadContextAttachmentDrafts.get('thread-CONTEXT')).toEqual([attachment]);

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-CONTEXT', onSend }));
    });
    expect(container.querySelector('[data-context-kind="thread"]')).not.toBeNull();

    act(() => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, undefined, [attachment]);
    expect(container.querySelector('[data-context-kind="thread"]')).toBeNull();
    expect(threadContextAttachmentDrafts.has('thread-CONTEXT')).toBe(false);
  });

  it('replaces an edited annotation in place without renumbering mixed draft attachments', async () => {
    const onSend = vi.fn();
    const threadAttachment = {
      v: 1 as const,
      id: 'ctx-thread-before-annotations',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Source Thread',
    };
    const first = {
      v: 1 as const,
      id: 'ctx-quote-first',
      kind: 'quote' as const,
      text: 'first selected source',
      comment: 'first comment',
      selectionStart: 0,
      selectionEnd: 21,
      source: { kind: 'message' as const, threadId: 'thread-ANNOTATION', messageId: 'msg-1' },
    };
    const second = {
      v: 1 as const,
      id: 'ctx-quote-second',
      kind: 'quote' as const,
      text: 'second selected source',
      comment: 'before edit',
      selectionStart: 22,
      selectionEnd: 44,
      source: { kind: 'message' as const, threadId: 'thread-ANNOTATION', messageId: 'msg-1' },
    };
    const updated = { ...second, comment: 'after edit' };
    threadContextAttachmentDrafts.set('thread-ANNOTATION', [threadAttachment, first, second]);

    act(() => root.render(React.createElement(ChatInput, { threadId: 'thread-ANNOTATION', onSend })));
    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-ANNOTATION',
        text: '',
        contextAttachments: [updated],
        removeContextAttachmentIds: [second.id],
      });
      await Promise.resolve();
    });

    expect(threadContextAttachmentDrafts.get('thread-ANNOTATION')).toEqual([threadAttachment, first, updated]);
    expect(threadContextAttachmentDrafts.get('thread-ANNOTATION')?.map(({ id }) => id)).toEqual([
      threadAttachment.id,
      first.id,
      second.id,
    ]);
    expect(threadContextAttachmentDrafts.get('thread-ANNOTATION')?.filter(({ id }) => id === second.id)).toHaveLength(
      1,
    );
    expect(container.querySelector('[data-testid="context-annotations-summary"]')?.textContent).toContain(
      '2 annotations',
    );
    act(() => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, undefined, [
      threadAttachment,
      first,
      updated,
    ]);
  });

  it('keeps structured context drafts when the send is rejected before admission', async () => {
    const onSend = vi.fn(async () => false);
    const attachment = {
      v: 1 as const,
      id: 'ctx-thread-rejected',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Source Thread',
    };

    act(() => root.render(React.createElement(ChatInput, { threadId: 'thread-REJECTED', onSend })));
    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-REJECTED',
        text: '',
        contextAttachments: [attachment],
      });
      await Promise.resolve();
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-context-kind="thread"]')).not.toBeNull();
    expect(threadContextAttachmentDrafts.get('thread-REJECTED')).toEqual([attachment]);
  });

  it('fails closed when persisted context draft JSON violates the shared schema', () => {
    const corrupt = JSON.stringify([
      [
        'thread-CORRUPT',
        [
          {
            v: 1,
            id: 'ctx-corrupt',
            kind: 'thread',
            threadId: 'thread-source',
            title: 'Source Thread',
            unexpected: 'legacy-markdown-bypass',
          },
        ],
      ],
    ]);
    expect(parseContextAttachmentDrafts(corrupt).size).toBe(0);
    expect(parseContextAttachmentDrafts('{broken').size).toBe(0);
  });

  it('hydrates the TTL=0 server draft on F5 and preserves a newer local session draft', async () => {
    threadDrafts.set('thread-DURABLE', 'local unsaved tail');
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-DURABLE/composer-draft' && (!init || init.method === 'GET')) {
        return apiResponse({
          revision: 7,
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-DURABLE',
            revision: 7,
            text: 'server recalled body',
            updatedAt: Date.now(),
          },
        });
      }
      return apiResponse({});
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-DURABLE', onSend: vi.fn() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getTextarea().value).toBe('server recalled body\n\nlocal unsaved tail');
  });

  it('accepts the recall ACK as authoritative and selects the inserted source range', async () => {
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-ACK', onSend: vi.fn() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => typeInto(getTextarea(), 'stale local snapshot'));

    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-ACK',
        text: 'existing draft\n\nrecalled source',
        authoritative: true,
        serverRevision: 4,
        selectionRange: { start: 16, end: 31 },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getTextarea().value).toBe('existing draft\n\nrecalled source');
    expect(getTextarea().selectionStart).toBe(16);
    expect(getTextarea().selectionEnd).toBe(31);
  });

  it('keeps unuploaded local images when an authoritative recall ACK has no persisted image blocks', async () => {
    const localImage = makeImageFile('unsent-local.png');
    act(() => root.render(React.createElement(ChatInput, { threadId: 'thread-LOCAL-IMAGE', onSend: vi.fn() })));
    await attachFiles([localImage]);
    expect(getPreviewImage('unsent-local.png')).not.toBeNull();

    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-LOCAL-IMAGE',
        text: 'server draft plus recalled source',
        authoritative: true,
        serverRevision: 2,
      });
      await Promise.resolve();
    });

    expect(getPreviewImage('unsent-local.png')).not.toBeNull();
  });

  it('flushes unsaved text and structured context before true recall reads the draft revision', async () => {
    const attachment = {
      v: 1 as const,
      id: 'ctx-flush-before-recall',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Source Thread',
    };
    let revision = 0;
    let persistedDraft: Record<string, unknown> | null = null;
    const calls: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-FLUSH/composer-draft' && (!init || init.method === 'GET')) {
        calls.push('GET');
        return apiResponse({ draft: persistedDraft, revision });
      }
      if (url === '/api/threads/thread-FLUSH/composer-draft' && init?.method === 'PUT') {
        calls.push('PUT');
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        revision += 1;
        persistedDraft = {
          version: 1,
          ownerUserId: 'u1',
          threadId: 'thread-FLUSH',
          revision,
          text: request.text,
          contentBlocks: request.contentBlocks,
          updatedAt: Date.now(),
        };
        return apiResponse({ draft: persistedDraft });
      }
      if (url === '/api/messages/message-FLUSH/recall' && init?.method === 'POST') {
        calls.push('POST');
        const request = JSON.parse(String(init.body)) as { expectedDraftRevision: number };
        expect(request.expectedDraftRevision).toBe(1);
        return apiResponse({ verdict: 'already_recalled', draft: persistedDraft, insertedRange: null, queue: [] });
      }
      return apiResponse({});
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-FLUSH', onSend: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => typeInto(getTextarea(), 'fresh unsaved text'));
    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId: 'thread-FLUSH',
        text: '',
        contextAttachments: [attachment],
      });
      await Promise.resolve();
    });

    await requestTrueRecall({
      threadId: 'thread-FLUSH',
      messageId: 'message-FLUSH',
      confirmAppend: () => true,
    });

    expect(calls.slice(-3)).toEqual(['PUT', 'GET', 'POST']);
    expect(persistedDraft).toMatchObject({
      text: 'fresh unsaved text',
      contentBlocks: [{ type: 'context_attachment', attachment }],
    });
  });

  it('fails closed before recall when the local draft flush cannot establish a durable revision', async () => {
    let conflictObserved = false;
    let recallPostCount = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-FLUSH-CONFLICT/composer-draft' && (!init || init.method === 'GET')) {
        return apiResponse({ draft: null, revision: conflictObserved ? 1 : 0 });
      }
      if (url === '/api/threads/thread-FLUSH-CONFLICT/composer-draft' && init?.method === 'PUT') {
        conflictObserved = true;
        return apiResponse({ error: 'revision mismatch' }, 409);
      }
      if (url === '/api/messages/message-FLUSH-CONFLICT/recall' && init?.method === 'POST') {
        recallPostCount += 1;
        return apiResponse({ verdict: 'already_recalled', draft: null, insertedRange: null, queue: [] });
      }
      return apiResponse({});
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-FLUSH-CONFLICT', onSend: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => typeInto(getTextarea(), '必须先安全落盘'));

    await expect(
      requestTrueRecall({
        threadId: 'thread-FLUSH-CONFLICT',
        messageId: 'message-FLUSH-CONFLICT',
        confirmAppend: () => true,
      }),
    ).rejects.toThrow('当前草稿尚未安全保存');
    expect(recallPostCount).toBe(0);
  });

  it('coalesces duplicate true-recall controls into one server mutation and one authoritative ACK', async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let postCount = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-DUPLICATE/composer-draft') {
        return apiResponse({ draft: null, revision: 0 });
      }
      if (url === '/api/messages/message-DUPLICATE/recall' && init?.method === 'POST') {
        postCount += 1;
        await postGate;
        return apiResponse({ verdict: 'already_recalled', draft: null, insertedRange: null, queue: [] });
      }
      return apiResponse({});
    });

    const first = requestTrueRecall({
      threadId: 'thread-DUPLICATE',
      messageId: 'message-DUPLICATE',
      confirmAppend: () => true,
    });
    const duplicate = requestTrueRecall({
      threadId: 'thread-DUPLICATE',
      messageId: 'message-DUPLICATE',
      confirmAppend: () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postCount).toBe(1);

    releasePost();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).not.toBeNull();
    expect(duplicateResult).toBeNull();
  });

  it('serializes recalls of different messages against the same thread draft revision', async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let draftRevision = 0;
    const posted: Array<{ messageId: string; expectedDraftRevision: number }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-SERIAL-RECALL/composer-draft') {
        return apiResponse({ draft: null, revision: draftRevision });
      }
      if (typeof url === 'string' && url.startsWith('/api/messages/message-SERIAL-') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { expectedDraftRevision: number };
        posted.push({
          messageId: url.split('/')[3] ?? '',
          expectedDraftRevision: request.expectedDraftRevision,
        });
        if (posted.length === 1) await postGate;
        draftRevision += 1;
        return apiResponse({
          verdict: 'zero_exposure',
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-SERIAL-RECALL',
            revision: draftRevision,
            text: `draft-${draftRevision}`,
            updatedAt: draftRevision,
          },
          insertedRange: { start: 0, end: 1 },
          queue: [],
        });
      }
      return apiResponse({});
    });

    const first = requestTrueRecall({
      threadId: 'thread-SERIAL-RECALL',
      messageId: 'message-SERIAL-A',
      confirmAppend: () => true,
    });
    const second = requestTrueRecall({
      threadId: 'thread-SERIAL-RECALL',
      messageId: 'message-SERIAL-B',
      confirmAppend: () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observedPostCount = posted.length;
    releasePost();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(observedPostCount).toBe(1);
    expect(firstResult).not.toBeNull();
    expect(secondResult).not.toBeNull();
    expect(posted).toEqual([
      { messageId: 'message-SERIAL-A', expectedDraftRevision: 0 },
      { messageId: 'message-SERIAL-B', expectedDraftRevision: 1 },
    ]);
  });

  it('requires explicit append confirmation and never replaces an existing unsent draft', async () => {
    const postedBodies: Array<{
      threadId: string;
      merge: string;
      expectedDraftRevision: number;
    }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-APPEND/composer-draft') {
        return apiResponse({
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-APPEND',
            revision: 4,
            text: '还没发送的本地草稿',
            updatedAt: 1,
          },
          revision: 4,
        });
      }
      if (url === '/api/messages/message-APPEND/recall' && init?.method === 'POST') {
        postedBodies.push(
          JSON.parse(String(init.body)) as {
            threadId: string;
            merge: string;
            expectedDraftRevision: number;
          },
        );
        return apiResponse({ verdict: 'already_recalled', draft: null, insertedRange: null, queue: [] });
      }
      return apiResponse({});
    });

    const rejected = await requestTrueRecall({
      threadId: 'thread-APPEND',
      messageId: 'message-APPEND',
      confirmAppend: () => false,
    });
    expect(rejected).toBeNull();
    expect(postedBodies).toEqual([]);

    await requestTrueRecall({
      threadId: 'thread-APPEND',
      messageId: 'message-APPEND',
      confirmAppend: () => true,
    });
    expect(postedBodies).toEqual([{ threadId: 'thread-APPEND', merge: 'append', expectedDraftRevision: 4 }]);
  });

  it('serializes autosave with the hydrated server revision', async () => {
    vi.useFakeTimers();
    const persistedBodies: Array<{ expectedRevision: number; text: string }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-SAVE/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') return apiResponse({ draft: null, revision: 3 });
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text: string };
      persistedBodies.push(request);
      return apiResponse({
        draft: {
          version: 1,
          ownerUserId: 'u1',
          threadId: 'thread-SAVE',
          revision: request.expectedRevision + 1,
          text: request.text,
          updatedAt: Date.now(),
        },
      });
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-SAVE', onSend: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => typeInto(getTextarea(), 'durable edit'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(persistedBodies).toEqual([{ expectedRevision: 3, text: 'durable edit' }]);
  });

  it('does not turn a stale-tab 409 into an automatic overwrite with the newly observed revision', async () => {
    vi.useFakeTimers();
    let hydrationReads = 0;
    const persistedBodies: Array<{ expectedRevision: number; text: string }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-CONFLICT/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        hydrationReads++;
        if (hydrationReads === 1) return apiResponse({ draft: null, revision: 3 });
        return apiResponse({
          revision: 4,
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-CONFLICT',
            revision: 4,
            text: 'remote edit',
            updatedAt: Date.now(),
          },
        });
      }
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text: string };
      persistedBodies.push(request);
      return apiResponse({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 4 }, 409);
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-CONFLICT', onSend: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => typeInto(getTextarea(), 'stale local edit'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(persistedBodies).toEqual([{ expectedRevision: 3, text: 'stale local edit' }]);
    expect(hydrationReads).toBe(2);
  });

  it('keeps the durable draft until message admission acknowledges the new identity', async () => {
    vi.useFakeTimers();
    let resolveAdmission!: (accepted: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      resolveAdmission = resolve;
    });
    const onSend = vi.fn(() => admission);
    const clears: number[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-ADMISSION/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        return apiResponse({
          revision: 5,
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-ADMISSION',
            revision: 5,
            text: 'authoritative recalled body',
            updatedAt: Date.now(),
          },
        });
      }
      if (init.method === 'DELETE') {
        const request = JSON.parse(String(init.body)) as { expectedRevision: number };
        clears.push(request.expectedRevision);
        return apiResponse({ cleared: true, revision: request.expectedRevision + 1 });
      }
      return apiResponse({});
    });

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-ADMISSION', onSend }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(clears).toEqual([]);

    await act(async () => {
      resolveAdmission(true);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(clears).toEqual([5]);
  });

  it('restores the admitted draft locally when the durable clear fails', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-CLEAR-FAIL/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        return apiResponse({
          revision: 5,
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-CLEAR-FAIL',
            revision: 5,
            text: '不能静默复活的正文',
            updatedAt: Date.now(),
          },
        });
      }
      if (init.method === 'DELETE') return apiResponse({ error: 'draft store unavailable' }, 503);
      return apiResponse({});
    });

    await act(async () => {
      root.render(
        React.createElement(ChatInput, {
          threadId: 'thread-CLEAR-FAIL',
          onSend: vi.fn(async () => true),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(getTextarea().value).toBe('不能静默复活的正文');
  });

  it('hydrates the newer authoritative draft when admission clear loses a revision race', async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-CLEAR-RACE/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        reads += 1;
        const draft =
          reads === 1 ? { revision: 5, text: '已经发送的旧草稿' } : { revision: 6, text: '另一标签页的新草稿' };
        return apiResponse({
          revision: draft.revision,
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-CLEAR-RACE',
            revision: draft.revision,
            text: draft.text,
            updatedAt: Date.now(),
          },
        });
      }
      if (init.method === 'DELETE') return apiResponse({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 6 }, 409);
      return apiResponse({});
    });

    await act(async () => {
      root.render(
        React.createElement(ChatInput, {
          threadId: 'thread-CLEAR-RACE',
          onSend: vi.fn(async () => true),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(getTextarea().value).toBe('另一标签页的新草稿');
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

  it('does not duplicate the same recovered image after switching away and back', async () => {
    const imageUrl = '/uploads/recovered-switch.png';
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-RECOVERED-IMAGE/composer-draft' && (!init || init.method === 'GET')) {
        return apiResponse({
          draft: {
            version: 1,
            ownerUserId: 'u1',
            threadId: 'thread-RECOVERED-IMAGE',
            revision: 1,
            text: '',
            contentBlocks: [{ type: 'image', url: imageUrl }],
            updatedAt: 1,
          },
          revision: 1,
        });
      }
      if (url === '/api/threads/thread-RECOVERED-OTHER/composer-draft' && (!init || init.method === 'GET')) {
        return apiResponse({ draft: null, revision: 0 });
      }
      if (url === imageUrl) return apiResponse({});
      return apiResponse({});
    });

    const renderThread = async (threadId: string) => {
      act(() => root.unmount());
      root = createRoot(container);
      await act(async () => {
        root.render(React.createElement(ChatInput, { threadId, onSend: vi.fn() }));
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await renderThread('thread-RECOVERED-IMAGE');
    expect(threadImageDrafts.get('thread-RECOVERED-IMAGE')).toHaveLength(1);
    await renderThread('thread-RECOVERED-OTHER');
    await renderThread('thread-RECOVERED-IMAGE');

    expect(threadImageDrafts.get('thread-RECOVERED-IMAGE')).toHaveLength(1);
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
    expect(onSend).toHaveBeenCalledWith('msg with image', [fakeImage], undefined, undefined, undefined, undefined);
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
    useChatStore.getState().setThreadHasDraft('thread-LRU-1', true);
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
    expect(useChatStore.getState().getThreadState('thread-LRU-1').hasDraft).toBe(false);
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

  it('syncs text drafts to sessionStorage for cross-navigation survival', () => {
    const onSend = vi.fn();
    const STORAGE_KEY = 'cat-cafe:thread-drafts';

    // Mount and type — draft should be written to sessionStorage
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-SS', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'persisted draft');
    });

    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    const entries: [string, string][] = JSON.parse(stored!);
    expect(entries).toContainEqual(['thread-SS', 'persisted draft']);
  });

  it('clears sessionStorage entry when draft is emptied', () => {
    const onSend = vi.fn();
    const STORAGE_KEY = 'cat-cafe:thread-drafts';

    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-CL', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'temp');
    });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // Clear the input
    act(() => {
      typeInto(getTextarea(), '');
    });

    // sessionStorage should have no entry for this thread
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const entries: [string, string][] = JSON.parse(stored);
      expect(entries.find(([k]) => k === 'thread-CL')).toBeUndefined();
    }
  });
});
