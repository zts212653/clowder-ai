import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { usePendingFeedback } from '../mailbox-feedback';

const item: UnifiedAttentionItemV1 = {
  decisionRef: 'user-mention:thread',
  kind: 'user_mention',
  summary: '真实请求',
  linkedNeedsMe: [],
  userMention: {
    threadId: 'thread',
    threadTitle: '原对话',
    messageId: 'message',
    catId: 'codex61-sol',
    content: '请核对',
    timestamp: 1,
    expectedRevision: 2,
  },
};
let host: HTMLDivElement, root: Root, feedback: ReturnType<typeof usePendingFeedback>;
function Harness({ items = [item], owner = 'owner' }: { items?: UnifiedAttentionItemV1[]; owner?: string }) {
  feedback = usePendingFeedback(items, owner);
  return (
    <>
      {feedback.project(items.map((item) => ({ kind: 'item', key: item.decisionRef, item }))).map((row) => (
        <span key={row.key}>{row.kind}</span>
      ))}
    </>
  );
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
it('retains only acknowledged exact rows through refresh, clears on close, and fences a changed owner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await act(async () =>
    feedback.acknowledge({
      owner: 'owner',
      result: 'handled',
      threadId: 'thread',
      messageId: 'stale',
      expectedRevision: 2,
    }),
  );
  expect(host.textContent).toBe('item');
  await act(async () =>
    feedback.acknowledge({
      owner: 'owner',
      result: 'handled',
      threadId: 'thread',
      messageId: 'message',
      expectedRevision: 2,
    }),
  );
  await act(async () => root.render(<Harness items={[]} />));
  expect(host.textContent).toBe('feedback');
  await act(async () => root.render(<Harness items={[]} owner="other" />));
  expect(host.textContent).toBe('');
  await act(async () => root.render(<Harness key="reopen" items={[]} />));
  expect(host.textContent).toBe('');
});
