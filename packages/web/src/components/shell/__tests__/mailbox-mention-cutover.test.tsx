import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳·砚砚' }));
vi.mock('../ShellCatAvatar', () => ({ ShellCatAvatar: () => null }));

import { MailboxRow } from '../mailbox/MailboxRow';
import { deriveMailboxState } from '../unified-mailbox-state';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
});
const item: UnifiedAttentionItemV1 = {
  decisionRef: 'user-mention:thread',
  kind: 'user_mention',
  summary: '请求',
  linkedNeedsMe: [],
  userMention: {
    threadId: 'thread',
    threadTitle: 'F320 登录修复',
    messageId: 'm',
    catId: 'codex61-sol',
    content: '@co-creator\n需要你重启。建议空闲时更新；今天不答会继续运行旧版。',
    timestamp: Date.now(),
  },
};
it('the collapsed request itself shows its conversation, exact text and time', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <MailboxRow item={item} rowKey="m" stale={false} expanded={false} onToggle={() => {}} onOpen={() => {}} />,
    ),
  );
  const heading = host.querySelector('[data-testid="mailbox-item-toggle"]');
  expect(heading?.textContent).toContain('F320 登录修复');
  expect(heading?.textContent).toContain('需要你重启。建议空闲时更新');
  expect(heading?.textContent).not.toContain('有事找你');
});

it('earlier rows and handled history never increase the rail attention number', () => {
  const base = {
    version: 1 as const,
    status: 'available' as const,
    scope: 'owner_all_projects' as const,
    identity: { ownerUserId: 'owner' },
    observedAt: 1,
    readWindow: { startedAt: 1, endedAt: 1, consistency: 'independent_source_reads' as const },
    consistency: { state: 'verified' as const, reasons: [] },
    sources: {
      structuredChoices: {
        status: 'available' as const,
        startedAt: 1,
        observedAt: 1,
        coverage: 'pending_f306_structured_choices' as const,
        exhaustiveness: 'complete' as const,
      },
      approvals: {
        status: 'available' as const,
        startedAt: 1,
        observedAt: 1,
        coverage: 'all_registered_F246_producers' as const,
        exhaustiveness: 'complete' as const,
      },
      needsMe: {
        status: 'available' as const,
        startedAt: 1,
        observedAt: 1,
        coverage: 'current_linked_F310_five_producers' as const,
        exhaustiveness: 'complete' as const,
      },
    },
    items: [item],
    totalCount: 558,
    attentionCount: 0,
    mentionPeriod: 'earlier' as const,
    page: { offset: 0, limit: 20, scope: 'known_rows' as const, hasMore: true },
  };
  expect(deriveMailboxState({ kind: 'ok', read: base })).toEqual({ kind: 'empty' });
  expect(deriveMailboxState({ kind: 'ok', read: { ...base, attentionCount: 2 } })).toEqual({
    kind: 'has-items',
    count: 2,
    partial: false,
  });
});
