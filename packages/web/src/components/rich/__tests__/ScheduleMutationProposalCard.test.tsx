import type { ScheduleMutationProposal } from '@cat-cafe/shared';
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { ApprovalItemCard } from '@/components/ApprovalItemCard';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';
import { coordinate, ok, scheduleBlock, scheduleItem, scheduleProposal } from './schedule-approval.fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, proposal: ScheduleMutationProposal, responseBody: unknown;
let onRead: (() => void) | undefined;
const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
const sent = () => vi.mocked(apiFetch).mock.calls.filter(([, o]) => o?.method === 'POST');
async function mount() {
  await act(async () =>
    root.render(
      <RichBlocks
        blocks={[scheduleBlock]}
        publication={{ ...coordinate, messageRevision: 'fixture-revision' }}
        messageId={coordinate.messageId}
      />,
    ),
  );
}
async function click(testId = 'schedule-approve') {
  await act(async () => button(testId)?.click());
}
function settled(status: 'approved' | 'rejected') {
  proposal = {
    ...proposal,
    status,
    ...(status === 'approved'
      ? {
          approvedAt: 2000,
          approvedBy: 'owner-1',
          effectCheckpoint:
            proposal.mutation.kind === 'create'
              ? { kind: 'create', taskId: proposal.mutation.task.id, appliedAt: 1900 }
              : {
                  kind: 'delete',
                  taskId: proposal.mutation.taskId,
                  expectedFingerprint: proposal.mutation.expectedFingerprint,
                  deletedAt: 1900,
                },
        }
      : { rejectedAt: 2000, rejectedBy: 'owner-1' }),
  };
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('zh');
  proposal = scheduleProposal();
  responseBody = undefined;
  onRead = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    const value = String(path);
    if (options?.method === 'POST') {
      if (responseBody !== undefined) return ok(responseBody);
      settled(value.endsWith('/reject') ? 'rejected' : 'approved');
      return ok({ proposalId: proposal.proposalId, status: proposal.status });
    }
    if (value === '/api/session') return ok({ userId: 'owner-1' });
    if (value === '/api/approval-hub/pending') return ok({ items: [scheduleItem(proposal)] });
    if (value === '/api/schedule/templates')
      return ok({
        templates: [
          {
            templateId: 'private-template',
            label: 'Evidence reminder',
            paramSchema: { text: { description: 'Original request' } },
          },
        ],
      });
    if (value === '/api/threads/destination')
      return ok({ id: 'destination', title: 'Original discussion', projectPath: 'default' });
    onRead?.();
    return ok({ proposal });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});

describe('original scheduled task, both hosts', () => {
  it('shows the full original task and names, folded content, theme action, and original create writer', async () => {
    await mount();
    expect(container.textContent).toContain('Read the evidence');
    expect(container.textContent).toContain('Original discussion');
    expect(container.textContent).toContain('Evidence reminder');
    expect(container.textContent).toContain('批准后 1 分钟 后执行一次');
    expect(container.textContent).not.toContain('Untrusted published title');
    expect(container.textContent).not.toContain('private-schedule');
    expect(container.textContent).not.toContain('private-template');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(button('schedule-approve')?.style.background).toBe('var(--shell-primary)');
    await click();
    expect(sent()).toHaveLength(1);
    expect(sent()[0][0]).toBe('/api/schedule-proposals/schedule-1/approve');
    expect(button('schedule-approve')).toBeNull();
    expect(button('schedule-reject')).toBeNull();
    expect(container.textContent).toContain('定时任务已创建并注册');
    expect(container.textContent).toContain('你');
  });
  it('uses the original reject route and canonical rejected read', async () => {
    await mount();
    await click('schedule-reject');
    expect(sent()[0][0]).toBe('/api/schedule-proposals/schedule-1/reject');
    expect(container.textContent).toContain('已拒绝');
    expect(container.textContent).not.toContain('已创建并注册');
  });
  it('permanent deletion keeps its fingerprint and original writer', async () => {
    const task = proposal.mutation.kind === 'create' ? proposal.mutation.task : proposal.mutation.taskSnapshot;
    proposal.mutation = {
      kind: 'delete',
      taskId: task.id,
      expectedFingerprint: 'original-fingerprint',
      taskSnapshot: task,
    };
    await mount();
    expect(button('schedule-approve')?.textContent).toBe('批准并永久删除');
    await click();
    expect(sent()).toHaveLength(1);
    expect(container.textContent).toContain('定时任务已永久删除');
  });
  it('rehydrates a canonical approved proposal after reload without offering writes', async () => {
    settled('approved');
    await mount();
    expect(button('schedule-approve')).toBeNull();
    expect(container.textContent).toContain('定时任务已创建并注册');
    expect(sent()).toHaveLength(0);
  });
  it('a socket event asks for canonical re-read and cannot settle by itself', async () => {
    await mount();
    await act(async () =>
      window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: scheduleProposal('approved') })),
    );
    expect(button('schedule-approve')).not.toBeNull();
    expect(container.textContent).not.toContain('已创建并注册');
    settled('approved');
    await act(async () => window.dispatchEvent(new Event('cat-cafe:proposal-updated')));
    expect(button('schedule-approve')).toBeNull();
    expect(container.textContent).toContain('已创建并注册');
  });
  it.each([
    false,
    true,
  ])('rechecks substantive host changes while preserving equivalent recovery reads: changed=%s', async (changed) => {
    proposal.status = 'applying';
    const item = scheduleItem(proposal),
      nextItem = structuredClone(item);
    if (changed) nextItem.requesterCatId = 'foreign-cat';
    await act(async () => root.render(<ApprovalItemCard item={item} />));
    onRead = () => {
      onRead = undefined;
      flushSync(() => root.render(<ApprovalItemCard item={nextItem} />));
    };
    await click();
    expect(sent()).toHaveLength(changed ? 0 : 1);
    if (!changed) expect(container.textContent).toContain('定时任务已创建并注册');
  });
  it('preserves resume-only applying state and retries the original approve writer', async () => {
    proposal.status = 'applying';
    await mount();
    expect(button('schedule-approve')?.textContent).toBe('重试执行');
    expect(button('schedule-reject')).toBeNull();
    await click();
    expect(sent()).toHaveLength(1);
    expect(container.textContent).toContain('已创建并注册');
  });
  it.each([
    'thread',
    'message',
    'owner',
    'requester',
    'staged',
  ] as const)('refuses an original %s mismatch before writes', async (failure) => {
    if (proposal.publication.state !== 'anchored') throw new Error('Anchored fixture required');
    if (failure === 'thread') proposal.publication.envelope.approvalCardRef.threadId = 'foreign-thread';
    if (failure === 'message') proposal.publication.envelope.approvalCardRef.messageId = 'foreign-message';
    if (failure === 'owner') proposal.ownerUserId = 'foreign-owner';
    if (failure === 'requester') proposal.requesterCatId = 'foreign-cat';
    if (failure === 'staged') proposal.publication = { state: 'staged', stagedAt: 1000 };
    await mount();
    expect(button('schedule-approve')).toBeNull();
    expect(sent()).toHaveLength(0);
    expect(container.textContent).toContain('重新读取');
  });
  it('requires the actual thread coordinate, not only a matching message ID', async () => {
    await act(async () => root.render(<RichBlocks blocks={[scheduleBlock]} messageId={coordinate.messageId} />));
    expect(button('schedule-approve')).toBeNull();
    expect(sent()).toHaveLength(0);
  });
  it('keeps a source read failure honest and exposes a reread', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    } as Response);
    await mount();
    expect(button('schedule-approve')).toBeNull();
    expect(container.textContent).toContain('重新读取');
  });
  it('unreadable successful POST never replaces a still-pending original record with success', async () => {
    responseBody = {};
    await mount();
    await click();
    expect(container.textContent).not.toContain('已创建并注册');
    expect(container.textContent).toContain('尚未确认');
    expect(button('schedule-approve')?.disabled).toBe(true);
  });
  it('full task or fingerprint changes during prepare prevent a stale POST', async () => {
    await mount();
    onRead = () => {
      scheduleTaskForTest().display.label = 'Changed original task';
    };
    await click();
    expect(sent()).toHaveLength(0);
    expect(container.textContent).toContain('已变化');
  });
  it('a successful-looking receipt with an unchanged original GET is still unconfirmed', async () => {
    responseBody = { proposalId: 'schedule-1', status: 'approved' };
    await mount();
    await click();
    expect(container.textContent).not.toContain('已创建并注册');
    expect(container.textContent).toContain('尚未确认');
  });
  it('uses the same original controller in Approval Hub and respects host reporting', async () => {
    const report = vi.fn();
    await act(async () =>
      root.render(
        <ApprovalHostContext.Provider
          value={{ ...PERMISSIVE_APPROVAL_HOST, presentation: 'mailbox', reportRequest: report }}
        >
          <ApprovalItemCard item={scheduleItem()} />
        </ApprovalHostContext.Provider>,
      ),
    );
    await click();
    expect(sent()).toHaveLength(1);
    expect(report.mock.calls[0][0]).toMatchObject({ phase: 'start', kind: 'producer-card' });
    expect(report.mock.calls[1][0]).toMatchObject({ phase: 'end', outcome: 'settled' });
  });
  it('English changes words without changing owner publication or endpoint', async () => {
    writeShellLanguage('en');
    await mount();
    expect(button('schedule-approve')?.textContent).toBe('Approve and create');
    await click();
    expect(container.textContent).toContain('Scheduled task created and registered');
    expect(container.textContent).toContain('You');
    expect(sent()[0][0]).toBe('/api/schedule-proposals/schedule-1/approve');
  });
  it('an approved record without its effect checkpoint cannot claim registration', async () => {
    settled('approved');
    delete proposal.effectCheckpoint;
    await mount();
    expect(container.textContent).toContain('效果暂未确认');
    expect(container.textContent).not.toContain('已创建并注册');
    expect(button('schedule-approve')).toBeNull();
  });
  it('closing during the fresh original read prevents the prepared producer POST', async () => {
    await mount();
    const original = vi.mocked(apiFetch).getMockImplementation();
    let release: ((response: Response) => void) | undefined;
    vi.mocked(apiFetch).mockImplementation((path, options, settings) => {
      if (String(path) === '/api/schedule-proposals/schedule-1' && !options?.method)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (!original) throw new Error('Original mock missing');
      return original(path, options, settings);
    });
    await act(async () => button('schedule-approve')?.click());
    expect(release).toBeDefined();
    act(() => root.unmount());
    await act(async () => release?.(ok({ proposal })));
    expect(sent()).toHaveLength(0);
    root = createRoot(container);
  });
});
function scheduleTaskForTest() {
  return proposal.mutation.kind === 'create' ? proposal.mutation.task : proposal.mutation.taskSnapshot;
}
