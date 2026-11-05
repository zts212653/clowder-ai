import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openExactPlace } from '@/components/shell/mailbox/open-exact-place';
import { WorkspaceChatRevealProvider } from '@/components/workbench/WorkspaceChatReveal';
import { useChatStore } from '@/stores/chatStore';
import { RecallCard } from '../RecallRow';

vi.mock('@/components/shell/mailbox/open-exact-place', () => ({ openExactPlace: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  window.history.replaceState({}, '', '/thread/own');
  useChatStore.setState({ currentThreadId: 'own', rightPanelOpen: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function renderLink(onReveal?: () => void, href = '/thread/own?message=source-message') {
  const card = (
    <RecallCard
      event={{
        id: 'cue',
        timestamp: 1,
        query: '',
        source: 'push',
        cueStatus: 'presented_unreported',
        resolverFamily: 'person_entity',
        results: [{ title: '原人物来源', sourceType: 'person_entity', href }],
      }}
    />
  );
  await act(async () =>
    root.render(
      onReveal ? (
        <WorkspaceChatRevealProvider threadId="own" onReveal={onReveal}>
          {card}
        </WorkspaceChatRevealProvider>
      ) : (
        card
      ),
    ),
  );
  await act(async () => container.querySelector('button')?.click());
  const link = container.querySelector('a');
  expect(link).not.toBeNull();
  if (!link) throw new Error('Expected the actual source link');
  return link;
}
it('same-thread source click enters the existing exact-place navigation instead of only changing the query', async () => {
  const link = await renderLink();
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => link.dispatchEvent(event));
  expect(openExactPlace).toHaveBeenCalledWith('message:own:source-message', '/thread/own');
  expect(event.defaultPrevented).toBe(true);
});
it('asks the owning Chat host to reveal the source conversation instead of toggling panel state itself', async () => {
  // The host re-opens the panel whenever rightPanelMode stays 'workspace', so a leaf flipping
  // rightPanelOpen cannot hide the mobile Workspace overlay; only the host's reveal path can.
  const onReveal = vi.fn();
  const link = await renderLink(onReveal);
  await act(async () => link.click());
  expect(onReveal).toHaveBeenCalledOnce();
  expect(useChatStore.getState().rightPanelOpen).toBe(true);
  expect(openExactPlace).toHaveBeenCalledWith('message:own:source-message', '/thread/own');
});
it('does not ask a different conversation host to reveal itself for a cross-thread source', async () => {
  const onReveal = vi.fn();
  const link = await renderLink(onReveal, '/thread/other?message=source-message');
  await act(async () => link.click());
  expect(onReveal).not.toHaveBeenCalled();
  expect(openExactPlace).toHaveBeenCalledWith('message:other:source-message', '/thread/own');
});
