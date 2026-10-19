import type { MediaContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ChatInput } from '../ChatInput';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage, syncDraftToStorage } from '../thread-drafts';
import {
  useRegisterWorkspaceChatWork,
  useWorkspaceChatWorkScope,
  WorkspaceChatWorkScopeProvider,
  WorkspaceChatWorkSurface,
} from '../workbench/WorkspaceChatWorkScope';

vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));

const threadId = 'thread-visible-work';
type Send = Parameters<typeof ChatInput>[0]['onSend'];
const attachment: MediaContextAttachment = {
  v: 1,
  id: 'current-work',
  kind: 'media',
  title: '我的画面',
  mediaType: 'image/png',
  source: { kind: 'artifact-review', reviewId: 'review-current', round: 2, expectedReviewRevision: 5 },
  selections: [],
};
let host: HTMLDivElement;
let root: Root;
let active: string | null;
let visible: boolean;
let scope: ReturnType<typeof useWorkspaceChatWorkScope>;

function Register() {
  scope = useWorkspaceChatWorkScope();
  return null;
}
async function render(send: Send, presentation: 'v2' | 'classic' = 'v2') {
  await act(async () =>
    root.render(
      <WorkspaceChatWorkScopeProvider
        threadId={threadId}
        getActiveSurfaceId={() => active}
        isHostVisible={() => visible}
      >
        <Register />
        <ChatInput presentation={presentation} threadId={threadId} onSend={send} />
      </WorkspaceChatWorkScopeProvider>,
    ),
  );
  scope?.register({ threadId, surfaceId: 'work', attachment, isVisible: () => visible });
}
const sendEnter = () =>
  act(async () =>
    host
      .querySelector('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    currentThreadId: threadId,
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    pendingChatInsert: null,
    replyToMessage: null,
  });
  syncDraftToStorage(threadId, '保留我的两行说明\n另一行');
  syncContextAttachmentDraftToStorage(threadId, []);
  active = 'work';
  visible = true;
  scope = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  syncDraftToStorage(threadId, undefined);
  syncContextAttachmentDraftToStorage(threadId, []);
});

it.each([
  'false',
  'throw',
  'reject',
] as const)('one visible-work send keeps its source snapshot and restores only explicit draft on %s', async (outcome) => {
  const send = vi.fn<Send>(() => {
    active = 'other';
    if (outcome === 'throw') throw new Error('admission refused');
    return outcome === 'reject' ? Promise.reject(new Error('admission refused')) : false;
  });
  await render(send);
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
  await sendEnter();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toEqual(['保留我的两行说明\n另一行', undefined, undefined, undefined, [attachment]]);
  expect(host.querySelector('textarea')?.value).toBe('保留我的两行说明\n另一行');
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
});

it('an explicit circle keeps its ID, words and source instead of acquiring a whole-work reference', async () => {
  const selected = {
    ...attachment,
    id: 'my-place',
    selections: [{ id: '8', selection: { kind: 'image-point' as const, x: 20, y: 30 }, instruction: '这里要保留' }],
  };
  syncContextAttachmentDraftToStorage(threadId, [selected]);
  const send = vi.fn<Send>(() => false);
  await render(send);
  await sendEnter();
  expect(send.mock.calls[0]?.[4]).toEqual([selected]);
  expect(getContextAttachmentDraft(threadId)).toEqual([selected]);
});

it('an unchanged owner render does not clear and re-register narrow composer eligibility', async () => {
  const changed = vi.fn();
  function Owner({ renderNumber }: { renderNumber: number }) {
    useRegisterWorkspaceChatWork(threadId, { ...attachment }, () => true);
    return <span>{renderNumber}</span>;
  }
  const show = (renderNumber: number) => (
    <WorkspaceChatWorkScopeProvider
      threadId={threadId}
      getActiveSurfaceId={() => 'work'}
      isHostVisible={() => true}
      onRegisteredWorkChange={changed}
    >
      <WorkspaceChatWorkSurface surfaceId="work">
        <Owner renderNumber={renderNumber} />
      </WorkspaceChatWorkSurface>
    </WorkspaceChatWorkScopeProvider>
  );
  await act(async () => root.render(show(1)));
  expect(changed).toHaveBeenCalledExactlyOnceWith('work');
  await act(async () => root.render(show(2)));
  expect(changed).toHaveBeenCalledOnce();
});

it.each([
  'hidden',
  'other-surface',
  'classic',
] as const)('%s does not add a temporary work to the original sender', async (condition) => {
  const send = vi.fn<Send>(() => false);
  await render(send, condition === 'classic' ? 'classic' : 'v2');
  if (condition === 'hidden') visible = false;
  if (condition === 'other-surface') active = 'other';
  await sendEnter();
  expect(send.mock.calls[0]?.[4]).toBeUndefined();
});

it('an old registration cleanup cannot remove its newer replacement and foreign thread reads stay empty', async () => {
  await render(vi.fn(() => false));
  const oldCleanup = scope?.register({ threadId, surfaceId: 'work', attachment, isVisible: () => true });
  const newer = { ...attachment, id: 'new-work', source: { ...attachment.source, expectedReviewRevision: 6 } };
  scope?.register({ threadId, surfaceId: 'work', attachment: newer, isVisible: () => true });
  oldCleanup?.();
  expect(scope?.read(threadId)).toEqual(newer);
  expect(scope?.read('foreign-thread')).toBeNull();
});

it('a visible work does not make an empty composer sendable', async () => {
  syncDraftToStorage(threadId, '');
  const send = vi.fn<Send>(() => false);
  await render(send);
  await sendEnter();
  expect(send).not.toHaveBeenCalled();
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
});

it.each([
  'accepted',
  'refused',
] as const)('one gallery send carries both exact originals once and preserves the whole draft on %s', async (outcome) => {
  const works: MediaContextAttachment[] = [0, 1].map((index) => ({
    ...attachment,
    id: `gallery-${index}`,
    title: `图${index + 1}.png`,
    source: { kind: 'artifact-review', reviewId: `review-${index}`, round: 2, expectedReviewRevision: 5 },
    gallery: {
      threadId,
      messageId: 'original-gallery',
      messageRevision: '12',
      item: { kind: 'content-block', index },
      index,
      count: 2,
    },
    selections: [
      { id: String(index + 1), selection: { kind: 'image-point', x: 20, y: 30 }, instruction: `图${index + 1}这一处` },
    ],
  }));
  syncContextAttachmentDraftToStorage(threadId, works);
  const send = vi.fn<Send>(() => outcome === 'accepted');
  await render(send);
  const input = host.querySelector('textarea');
  expect(host.querySelector('[data-testid="gallery-draft-summary"]')?.textContent).toContain('2 张图 · 2 处');
  await sendEnter();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toEqual(['保留我的两行说明\n另一行', undefined, undefined, undefined, works]);
  expect(host.querySelector('textarea')).toBe(input);
  expect(getContextAttachmentDraft(threadId)).toEqual(outcome === 'accepted' ? [] : works);
  if (outcome === 'refused') expect(input?.value).toBe('保留我的两行说明\n另一行');
});
