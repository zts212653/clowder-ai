import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CardBlock } from '@/components/rich/CardBlock';
import { HandoffProposalCard } from '@/components/rich/HandoffProposalCard';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { writeShellLanguage } from '../../shell-language';
import { writeShellPresentation } from '../../shell-presentation';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { collectiveFailure } from './collective-failure.fixture';
import { approvalRow, okRead, storeItem } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, starts: number;
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
function source(kind: 'F225' | 'F231'): UnifiedAttentionItemV1 {
  const proposalId = 'original-p',
    prefix = kind === 'F225' ? 'handoff' : 'profile-update';
  const item = approvalRow(storeItem({ sourceFeatureId: kind, proposalId, inlineApprovable: false }));
  const nav = item.approval?.navigation;
  if (!nav || nav.state !== 'anchored') throw new Error('anchored fixture');
  item.originalApprovalCard = {
    cardRef: { ...nav.approvalCardRef, blockId: `${prefix}-${proposalId}` },
    block: {
      kind: 'card',
      v: 1,
      id: `${prefix}-${proposalId}`,
      title: kind === 'F225' ? 'Continue this session' : 'Update your profile',
      bodyMarkdown:
        kind === 'F225'
          ? 'Keep the current work and continue.'
          : 'Keep your confirmed preference.\n\n**当前内容：**\n```\nBefore\n```\n\n**提议改为：**\n```\nAfter\n```',
      fields: [{ label: kind === 'F225' ? 'Next steps' : '目标', value: 'Verify the original result' }],
      meta: { approval: { producerId: kind, canonicalProposalId: proposalId } },
      actions: [
        { label: kind === 'F225' ? '批准并接力' : '批准并写入', action: `${prefix}:approve`, payload: { proposalId } },
        { label: '驳回', action: `${prefix}:reject`, payload: { proposalId } },
      ],
    },
  };
  return item;
}
beforeEach(() => {
  observeApiSessionOwner('owner-1');
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  starts = 1;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (String(url) === '/api/session') return json({ userId: 'owner-1' });
    if (options?.method === 'POST') return json({ proposalId: 'original-p', status: 'approved' });
    if (String(url).includes('/session-handoff/'))
      return json({ proposal: { proposalId: 'original-p', status: 'pending' } });
    return json({ proposalId: 'original-p', status: 'pending' });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  writeShellPresentation('classic');
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
async function render(
  item: UnifiedAttentionItemV1,
  current = true,
  readOwner = 'owner-1',
  hasReader = true,
  outage = false,
) {
  const sessions = createApprovalSessions({
    readsStarted: () => starts,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [],
    attempts: () => ({}),
    latestRead: () => ({
      result: outage
        ? collectiveFailure(okRead([item], { identity: { ownerUserId: readOwner } }), true)
        : okRead([item], { identity: { ownerUserId: readOwner } }),
      generation: 1,
    }),
    now: Date.now,
  });
  if (!hasReader) delete sessions.currentItem;
  await act(async () =>
    root.render(
      <MailboxRow
        item={item}
        rowKey="original-card"
        stale={false}
        expanded={false}
        onToggle={() => {}}
        onOpen={() => {}}
        readCurrent={current}
        hosted={{ sessions, ownerUserId: 'owner-1' }}
      />,
    ),
  );
  return sessions;
}
const primary = (kind: 'F225' | 'F231') =>
  [...container.querySelectorAll('button')].find(
    (b) => !b.hasAttribute('aria-expanded') && b.textContent?.includes(kind === 'F225' ? '批准并接力' : '批准并写入'),
  );
it.each([
  'F225',
  'F231',
] as const)('hosts the full original %s card and its own writer while collapsed, without flipping generic inline permission', async (kind) => {
  const item = source(kind);
  const sessions = await render(item);
  expect(primary(kind)).toBeDefined();
  expect(item.approval?.inlineApprovable).toBe(false);
  expect(container.textContent?.split(item.originalApprovalCard!.block.title).length).toBe(2);
  await act(async () => primary(kind)?.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, o]) => o?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe(`/api/${kind === 'F225' ? 'session-handoff' : 'profile-updates'}/original-p/approve`);
  expect(sessions.list()).toHaveLength(1);
});
it.each(['F225', 'F231'] as const)('blocks an old %s DOM after a newer read starts', async (kind) => {
  await render(source(kind));
  expect(primary(kind)).toBeDefined();
  starts = 2;
  await act(async () => primary(kind)?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
it.each([
  'F225',
  'F231',
] as const)('keeps %s visibly read-only when a legacy host has no current-reader capability', async (kind) => {
  await render(source(kind), true, 'owner-1', false);
  expect(primary(kind)?.disabled).toBe(true);
  await act(async () => primary(kind)?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
it.each([
  'F225',
  'F231',
] as const)('does not host %s when source proof payload belongs to another proposal', async (kind) => {
  const item = source(kind);
  const action = item.originalApprovalCard?.block.actions?.[0];
  if (!action) throw new Error('original fixture action');
  action.payload = { proposalId: 'foreign' };
  await render(item);
  expect(primary(kind)).toBeUndefined();
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});

it.each(['F225', 'F231'] as const)('does not let %s submit when its original status read fails', async (kind) => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: false,
    status: 503,
    json: async () => ({ error: 'unavailable' }),
  } as Response);
  await render(source(kind));
  expect(primary(kind)?.disabled).toBe(true);
  await act(async () => primary(kind)?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
it.each([
  'F225',
  'F231',
] as const)('hydrates terminal %s from the original status route and removes its writer', async (kind) => {
  vi.mocked(apiFetch).mockResolvedValue(
    json(
      kind === 'F225'
        ? { proposal: { proposalId: 'original-p', status: 'approved' } }
        : { proposalId: 'original-p', status: 'approved' },
    ),
  );
  await render(source(kind));
  expect(primary(kind)).toBeUndefined();
  expect(container.textContent).toContain(kind === 'F225' ? '已同意 · 接力已发起' : '已同意 · 已写入档案');
});

it.each([
  'F225',
  'F231',
] as const)('keeps the original %s long content folded and its primary action on the first layer', async (kind) => {
  await render(source(kind));
  const disclosure = container.querySelector<HTMLDetailsElement>('[data-testid="original-approval-long-content"]');
  expect(disclosure).not.toBeNull();
  expect(disclosure?.open).toBe(false);
  expect(disclosure?.querySelector('summary')?.textContent).toBeTruthy();
  expect(disclosure?.contains(primary(kind) ?? null)).toBe(false);
  expect(disclosure?.textContent).toContain(kind === 'F225' ? 'Verify the original result' : 'Before');
  expect(disclosure?.textContent).toContain(kind === 'F225' ? 'Next steps' : 'After');
  expect(container.textContent).toContain(kind === 'F225' ? 'Keep the current work' : 'Keep your confirmed preference');
});

it.each(['F225', 'F231'] as const)('blocks %s while its original producer is still approving', async (kind) => {
  vi.mocked(apiFetch).mockResolvedValue(
    json(
      kind === 'F225'
        ? { proposal: { proposalId: 'original-p', status: 'approving' } }
        : { proposalId: 'original-p', status: 'approving' },
    ),
  );
  await render(source(kind));
  expect(primary(kind)?.disabled).toBe(true);
});

it.each(['F225', 'F231'] as const)('does not let an old %s row borrow a foreign owner read', async (kind) => {
  const item = source(kind);
  await render(item, true, 'foreign-owner');
  await act(async () => primary(kind)?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it.each([
  'F225',
  'F231',
] as const)('the original v2 Chat %s card uses the same folded content and theme primary action', async (kind) => {
  const item = source(kind);
  const block = item.originalApprovalCard?.block;
  if (!block) throw new Error('original fixture');
  await act(async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    root.render(
      kind === 'F225' ? (
        <HandoffProposalCard block={block} messageId="original-message" />
      ) : (
        <CardBlock block={block} messageId="original-message" />
      ),
    );
  });
  const disclosure = container.querySelector<HTMLDetailsElement>('[data-testid="original-approval-long-content"]');
  expect(disclosure).not.toBeNull();
  expect(disclosure?.open).toBe(false);
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(kind === 'F225' ? 'Approve and hand off' : 'Approve and write'),
  );
  expect(button?.style.background).toBe('var(--shell-primary)');
  await act(async () => button?.click());
  expect(vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it.each([
  'F225',
  'F231',
] as const)('submits the original %s writer under a dual Collective failure with its original payload', async (kind) => {
  const item = source(kind);
  await render(item, true, 'owner-1', true, true);
  await act(async () => primary(kind)?.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe(`/api/${kind === 'F225' ? 'session-handoff' : 'profile-updates'}/original-p/approve`);
  expect(posts[0][1]?.body && JSON.parse(String(posts[0][1].body))).toBeDefined();
});
