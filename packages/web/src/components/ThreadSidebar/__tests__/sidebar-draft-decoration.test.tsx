import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DraftReplyContext,
  syncDraftToStorage,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/thread-drafts';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { useSidebarDraftDecoration, useSidebarRowHeight } from '../sidebar-draft-decoration';

function Probe({ id }: { id: string }) {
  return <span data-testid={`probe-${id}`}>{String(useSidebarDraftDecoration(id))}</span>;
}

const HEIGHT_ROW = {
  id: 'A',
  presence: { status: 'idle' },
  unreadCount: 0,
  hasUserMention: false,
} as SidebarSnapshotRow;
const HEIGHT_ROWS = [HEIGHT_ROW];
const MOCK_GROUP_DECISIONS = { status: 'ready' as const, threadIds: new Set<string>() };
function HeightProbe({ currentId = null, compact = true }: { currentId?: string | null; compact?: boolean }) {
  return (
    <span data-testid="height">
      {useSidebarRowHeight(HEIGHT_ROWS, currentId, compact, MOCK_GROUP_DECISIONS)(HEIGHT_ROW)}
    </span>
  );
}

const REPLY: DraftReplyContext = { id: 'm1', content: 'quoted', senderCatId: null, threadId: 'A' };

/**
 * F322 / F297: the Sidebar's one named draft adapter. The flag the composer writes into `threadStates` exists only while a
 * composer has been mounted for that thread in this page load, so after a reload an offscreen thread whose draft survived
 * (text, reply and context drafts are hydrated from sessionStorage by `thread-drafts`, the composer's own owner) lost its
 * [草稿] marker. The adapter reads the owner the composer already writes; it keeps no state of its own.
 */
describe('the Sidebar draft decoration', () => {
  let host: HTMLDivElement;
  let root: Root;
  const text = (id: string) => host.querySelector(`[data-testid="probe-${id}"]`)?.textContent;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    threadDrafts.clear();
    threadReplyDrafts.clear();
    threadContextAttachmentDrafts.clear();
    threadImageDrafts.clear();
    useChatStore.setState({ threadStates: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    threadDrafts.clear();
    threadReplyDrafts.clear();
    threadContextAttachmentDrafts.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('is off for a thread with no draft anywhere', () => {
    act(() => root.render(<Probe id="A" />));
    expect(text('A')).toBe('false');
  });

  it('after a reload: shows a text draft that survived in storage although no composer ever flagged the thread', () => {
    threadDrafts.set('A', 'half a sentence');
    expect(useChatStore.getState().threadStates.A).toBeUndefined();
    act(() => root.render(<Probe id="A" />));
    expect(text('A')).toBe('true');
  });

  it('after a reload: a reply-only draft and a context-attachment draft count too', () => {
    threadReplyDrafts.set('A', REPLY);
    threadContextAttachmentDrafts.set('B', [{ kind: 'x' } as never]);
    act(() =>
      root.render(
        <>
          <Probe id="A" />
          <Probe id="B" />
        </>,
      ),
    );
    expect(text('A')).toBe('true');
    expect(text('B')).toBe('true');
  });

  it('follows the owner live: typing turns it on, clearing the text turns it off, without any composer mounted', () => {
    act(() => root.render(<Probe id="A" />));
    expect(text('A')).toBe('false');
    act(() => syncDraftToStorage('A', 'typed elsewhere'));
    expect(text('A')).toBe('true');
    act(() => syncDraftToStorage('A', undefined));
    expect(text('A')).toBe('false');
  });

  it('keeps what the composer flag already did: a flagged thread with nothing in the owner still shows', () => {
    useChatStore.setState({ threadStates: { A: { ...DEFAULT_THREAD_STATE, hasDraft: true } } });
    act(() => root.render(<Probe id="A" />));
    expect(text('A')).toBe('true');
    act(() => useChatStore.getState().setThreadHasDraft('A', false));
    expect(text('A')).toBe('false');
  });

  it('is per thread: a draft on A says nothing about B', () => {
    threadDrafts.set('A', 'only A');
    act(() =>
      root.render(
        <>
          <Probe id="A" />
          <Probe id="B" />
        </>,
      ),
    );
    expect(text('A')).toBe('true');
    expect(text('B')).toBe('false');
  });

  it('a whitespace-only text draft is not a draft (the owner trims, so does the marker)', () => {
    threadDrafts.set('A', '   \n ');
    act(() => root.render(<Probe id="A" />));
    expect(text('A')).toBe('false');
  });
  it('updates virtual row height from the draft owner for active v2 rows while keeping classic at 80px', () => {
    act(() => root.render(<HeightProbe />));
    expect(host.textContent).toBe('52');
    act(() => syncDraftToStorage('A', 'A kept draft'));
    expect(host.textContent).toBe('76');
    act(() => root.render(<HeightProbe currentId="A" />));
    expect(host.textContent).toBe('76');
    act(() => root.render(<HeightProbe compact={false} />));
    expect(host.textContent).toBe('80');
    act(() => syncDraftToStorage('A', ''));
    act(() => root.render(<HeightProbe />));
    expect(host.textContent).toBe('52');
    act(() => useChatStore.setState({ threadStates: { A: { ...DEFAULT_THREAD_STATE, hasDraft: true } } }));
    expect(host.textContent).toBe('76');
  });
});
