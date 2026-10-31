import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  ChatInput,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/ChatInput';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
} from '@/components/new-conversation/new-conversation-intent-store';
import { useNewConversationAdmission } from '@/components/new-conversation/useNewConversationAdmission';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  createCanonicalImageRecoveryScenario,
  createDelayedHydrationScenario,
} from './new-conversation-admission-host-fixture';

vi.mock('@/components/icons/SendIcon', () => ({ SendIcon: () => React.createElement('span', null, 'send') }));
vi.mock('@/components/icons/LoadingIcon', () => ({ LoadingIcon: () => React.createElement('span', null, 'loading') }));
vi.mock('@/components/icons/AttachIcon', () => ({ AttachIcon: () => React.createElement('span', null, 'attach') }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
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
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => undefined) }));

const sendMocks = vi.hoisted(() => ({ handleSend: vi.fn(async () => true) }));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: sendMocks.handleSend, uploadStatus: 'idle', uploadError: null }),
}));

const owner = 'sol61-review-owner';
const navigate = vi.fn();
let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useNewConversationAdmission>;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function Host() {
  latest = useNewConversationAdmission(navigate);
  return latest.ready ? (
    <ChatInput
      threadId="default"
      presentation="v2"
      disabled={latest.phase === 'creating' || latest.phase === 'sending'}
      onDraftChange={latest.onDraftChange}
      onSend={(content, images, whisper, replyToId, contextAttachments, explicitTargetCats) =>
        latest.send({ content, images, whisper, replyToId, contextAttachments, explicitTargetCats })
      }
    />
  ) : null;
}

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function typeInto(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native textarea value setter');
  setter.call(getTextarea(), value);
  getTextarea().dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForAct(assertion: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    await assertion();
  });
}

async function attachLocalImage(): Promise<void> {
  await attachFiles([new File(['local'], 'local-first.png', { type: 'image/png' })]);
}

async function attachFiles(files: File[]): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

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
  vi.mocked(apiFetch).mockReset();
  navigate.mockReset();
  sendMocks.handleSend.mockReset();
  sendMocks.handleSend.mockResolvedValue(true);
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name ?? 'image'}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.clearAllMocks();
  await clearNewConversationIntent(owner);
  _resetNewConversationIntentDbForTests();
});

it('requires confirmation without losing local or hydrated text, context, images, or reply', async () => {
  const { context, state, server } = createDelayedHydrationScenario(owner);
  navigate.mockImplementation(() => root.render(<div>real thread</div>));
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  await act(async () => typeInto('new local first message'));
  await attachLocalImage();
  await pressEnter();
  await waitForAct(() => expect(server.hydrationRequested()).toBe(true));
  expect(sendMocks.handleSend).not.toHaveBeenCalled();

  await act(async () => server.releaseHydration());
  await waitForAct(() => {
    expect(getTextarea().value).toContain('saved draft from other tab');
    expect(getTextarea().value).toContain('new local first message');
  });
  expect(state.draft?.text).toContain('saved draft from other tab');
  expect(state.draft?.text).toContain('new local first message');
  expect(state.draft?.contentBlocks).toEqual(
    expect.arrayContaining([
      { type: 'image', url: '/api/media/restored.png' },
      { type: 'context_attachment', attachment: context },
    ]),
  );
  expect(state.draft?.replyTo).toBe('restored-reply');
  expect(threadImageDrafts.get('default')).toHaveLength(2);
  expect(threadContextAttachmentDrafts.get('default')).toEqual([context]);
  expect(useChatStore.getState().replyToMessage?.id).toBe('restored-reply');
  expect(latest).toMatchObject({ phase: 'draft_recovered', localSaveFailed: false });
  expect((await loadNewConversationIntent(owner))?.intent.creationStarted).toBe(false);
  expect((await loadNewConversationIntent(owner))?.files).toHaveLength(2);
  expect(navigate).not.toHaveBeenCalled();
  expect(server.deletes).toEqual([]);

  await pressEnter();
  await waitForAct(() => expect(navigate).toHaveBeenCalledWith('created'));
  const sentCall = (sendMocks.handleSend.mock.calls as unknown[][])[0];
  expect(sentCall?.[0]).toContain('saved draft from other tab');
  expect(sentCall?.[0]).toContain('new local first message');
  expect(sentCall?.[1]).toHaveLength(2);
  expect(sentCall?.[4]).toBe('restored-reply');
  expect(sentCall?.[5]).toEqual([context]);
  expect(server.puts).toEqual([expect.objectContaining({ expectedRevision: 1, replyTo: 'restored-reply' })]);
  expect(server.deletes).toEqual([2]);
  expect(state.draft).toBeNull();
});

it('keeps a failed canonical image until the user explicitly discards it', async () => {
  const { events, state } = createCanonicalImageRecoveryScenario(owner, {
    imageUrl: '/uploads/missing-review.png',
    failImage: true,
  });
  navigate.mockImplementation(() => root.render(<div>real thread</div>));
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(events).toContain('image:failed'));
  await waitForAct(() => expect(getTextarea().value).toBe('saved image draft'));

  await act(async () => typeInto('saved image draft with edit'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  await waitForAct(() => expect(events).toContain('put:2'));
  await pressEnter();

  expect(sendMocks.handleSend).not.toHaveBeenCalled();
  expect(events).not.toContain('create');
  expect(state.draft?.contentBlocks).toContainEqual({ type: 'image', url: '/uploads/missing-review.png' });
  const recoveryNotice = container.querySelector('[data-testid="composer-recovered-attachments-blocked"]');
  expect(recoveryNotice).not.toBeNull();

  const discard = container.querySelector(
    '[data-testid="composer-recovered-attachments-discard"]',
  ) as HTMLButtonElement;
  await act(async () => discard.click());
  await waitForAct(() =>
    expect(container.querySelector('[data-testid="composer-recovered-attachments-blocked"]')).toBeNull(),
  );
  expect(state.draft?.contentBlocks ?? []).not.toContainEqual({ type: 'image', url: '/uploads/missing-review.png' });

  await pressEnter();
  await waitForAct(() => expect(navigate).toHaveBeenCalledWith('created'));
  expect((sendMocks.handleSend.mock.calls as unknown[][])[0]?.[1]).toBeUndefined();
  expect(state.draft).toBeNull();
});

it('keeps v2 attachment recovery controls out of an existing classic conversation', async () => {
  const { events } = createCanonicalImageRecoveryScenario(owner, {
    imageUrl: '/uploads/classic-missing.png',
    failImage: true,
  });
  const sendExistingMessage = vi.fn(async () => true);

  await act(async () =>
    root.render(<ChatInput threadId="default" presentation="classic" onSend={sendExistingMessage} />),
  );
  await waitForAct(() => expect(events).toContain('image:failed'));
  await waitForAct(() => expect(getTextarea().value).toBe('saved image draft'));

  expect(container.querySelector('[data-testid="composer-recovered-attachments-blocked"]')).toBeNull();
  await pressEnter();
  expect(sendExistingMessage).toHaveBeenCalledOnce();
});

it('blocks an over-limit canonical image until a local file is removed and recovery is retried', async () => {
  const { events, server, state } = createCanonicalImageRecoveryScenario(owner, {
    imageUrl: '/uploads/restored-review.png',
    delayedHydration: true,
  });
  navigate.mockImplementation(() => root.render(<div>real thread</div>));
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  await act(async () => typeInto('new local first message'));
  await attachFiles(
    Array.from(
      { length: 5 },
      (_unused, index) => new File([`local-${index}`], `local-${index}.png`, { type: 'image/png' }),
    ),
  );
  await pressEnter();
  await waitForAct(() => expect(server.hydrationRequested()).toBe(true));
  await act(async () => server.releaseHydration());
  await waitForAct(() =>
    expect(container.querySelector('[data-testid="composer-recovered-attachments-blocked"]')).not.toBeNull(),
  );

  await pressEnter();
  expect(sendMocks.handleSend).not.toHaveBeenCalled();
  expect(events).not.toContain('create');
  expect(state.draft).not.toBeNull();

  const removeFirst = container.querySelector('button[aria-label^="Remove "]') as HTMLButtonElement;
  await act(async () => removeFirst.click());
  const retry = container.querySelector('[data-testid="composer-recovered-attachments-retry"]') as HTMLButtonElement;
  await act(async () => retry.click());
  await waitForAct(() =>
    expect(container.querySelector('[data-testid="composer-recovered-attachments-blocked"]')).toBeNull(),
  );
  expect(threadImageDrafts.get('default')).toHaveLength(5);
  expect(threadImageDrafts.get('default')?.some((file) => file.name.startsWith('recalled-'))).toBe(true);

  await pressEnter();
  await waitForAct(() => expect(navigate).toHaveBeenCalledWith('created'));
  const sentFiles = (sendMocks.handleSend.mock.calls as unknown[][])[0]?.[1] as File[];
  expect(sentFiles).toHaveLength(5);
  expect(sentFiles.some((file) => file.name.startsWith('recalled-'))).toBe(true);
  expect(state.draft).toBeNull();
});
