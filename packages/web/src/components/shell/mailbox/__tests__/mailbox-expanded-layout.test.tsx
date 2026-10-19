import type { RuntimeInteractionRequest, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { cardRef, owner, provider, record, setSelect } from '../../../rich/__tests__/runtime-interaction-test-fixtures';
import { writeShellLanguage } from '../../shell-language';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { MailboxRow } from '../MailboxRow';
import { resolveOriginalPlace } from '../original-place';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead, storeItem } from './mailbox-fixtures';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ threads: [], currentThreadId: null });
  useChatStore.getState = () => ({ threads: [], currentThreadId: null });
  return { useChatStore };
});
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../../../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

const approval = storeItem({ summary: 'Save the isolated meeting note' });
const question: Extract<RuntimeInteractionRequest, { kind: 'question' }> = {
  version: 1,
  kind: 'question',
  interactionId: 'interaction-ui',
  owner: { ...owner, userId: OWNER },
  provider,
  createdAt: 1000,
  title: 'Choose the verification environment',
  description: 'Only the isolated sample will be changed.',
  questions: [
    { id: 'environment', header: 'Environment', question: 'Where should it run?', options: [{ label: 'Alpha' }] },
  ],
};
const choice: UnifiedAttentionItemV1 = {
  decisionRef: 'runtime:interaction-ui',
  kind: 'judgment',
  summary: question.title,
  linkedNeedsMe: [],
  choiceRequest: {
    interactionId: question.interactionId,
    revision: 2000,
    requesterCatId: question.owner.catId,
    createdAt: question.createdAt,
    title: question.title,
    questions: question.questions,
    cardRef,
  },
};
const accountability: UnifiedAttentionItemV1 = {
  decisionRef:
    'f290.collective_work_accountability_request:collective-accountability-request:svc_abcdefgh:col_abcdefgh:work_abcdefgh:accountability_abcdefgh',
  kind: 'judgment',
  summary: 'You 邀请你负责「完成接责验收」 · 共同项目',
  linkedNeedsMe: [],
  collectiveAccountabilityRequest: {
    producerId: 'f290.collective_work_accountability_request',
    subjectRef: 'collective-accountability-request:svc_abcdefgh:col_abcdefgh:work_abcdefgh:accountability_abcdefgh',
    serviceInstanceId: 'svc_abcdefgh',
    collectiveId: 'col_abcdefgh',
    connectionId: 'con_abcdefgh',
    workId: 'work_abcdefgh',
    workRevision: 2,
    accountabilityRequestId: 'accountability_abcdefgh',
    targetHumanId: 'human_abcdefgh',
    targetDisplayName: 'WuLang',
    requestedByHumanId: 'human_requester',
    requestedByDisplayName: 'You',
    requestEventId: 'evt_request000',
    requestedAt: '2026-10-18T12:00:00.000Z',
    status: 'pending',
    roadmapId: 'roadmap_abcdefgh',
    projectTitle: '共同项目',
    channelId: 'general',
    workSourceEventId: 'evt_source0000',
    workTitle: '完成接责验收',
    actionRef:
      '/collective?target=accountability&connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=2&channelId=general&roadmapId=roadmap_abcdefgh&accountabilityRequestId=accountability_abcdefgh',
    expectedProducerRevision: 2,
  },
};
const collectiveResult = {
  decisionRef: 'f290.collective_work_result:collective-result:con_abcdefgh:work_abcdefgh',
  kind: 'judgment',
  summary: 'Review the prepared result in its Collective Work',
  linkedNeedsMe: [
    {
      ownerRead: {
        envelope: {
          subjectRef: 'task:work:result-ready',
          revision: 3,
          visibility: { ownerUserId: OWNER },
        },
        brief: { outcome: { state: 'known', value: '可验收的共同体成果' } },
        work: { title: '准备共同体成果', ownerCatId: 'codex-sol' },
        preparedArtifact: {
          artifactRef: 'artifact:result',
          artifactRevision: '7',
          completenessRef: 'artifact:result#complete:7',
          previewRef: 'artifact:result#preview:7',
          openInWorkspaceRef: 'workspace:artifact:thread-private:7:artifact:result',
        },
      },
      receipt: {
        eligible: true,
        producer: {
          producerId: 'f290.collective_work_result',
          ownerRef: 'collective-result:con_abcdefgh:work_abcdefgh',
          subjectRef: 'collective-result:con_abcdefgh:work_abcdefgh',
          revision: 4,
        },
        taskRef: { subjectRef: 'task:work:result-ready', observedRevision: 3 },
        kind: 'judgment',
        reasonCode: 'collective_result_ready',
        recommendation: 'Review the prepared result in its Collective Work',
        salience: 'normal',
        action: { actionRef: '/collective?workId=work_abcdefgh', expectedProducerRevision: 4 },
        reEvaluateActionRef: 'collective-result:con_abcdefgh:work_abcdefgh#reevaluate',
      },
    },
  ],
} as unknown as UnifiedAttentionItemV1;
const withCoordinate = (item: UnifiedAttentionItemV1): UnifiedAttentionItemV1 => ({
  ...item,
  preferenceCoordinate: { kind: 'mailbox', decisionRef: item.decisionRef, version: 'exact-version' },
});
const personal = { mode: 'visible' as const, refusal: () => null, change: vi.fn(async () => true) };
const onOpen = vi.fn();
let root: Root;
let container: HTMLDivElement;

function Wrapper({ item, expanded = true }: { item: UnifiedAttentionItemV1; expanded?: boolean }) {
  const view: UnifiedAttentionView = {
    result: okRead([item]),
    staleRead: null,
    refetch: vi.fn(),
    readsStarted: () => 1,
    resultGeneration: 1,
  };
  const sessions = useApprovalSessions(view);
  return (
    <MailboxRow
      item={item}
      rowKey={item.decisionRef}
      stale={false}
      expanded={expanded}
      onToggle={vi.fn()}
      onOpen={onOpen}
      hosted={{ sessions, ownerUserId: OWNER }}
      personal={personal}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  personal.change.mockClear();
  onOpen.mockClear();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/approval-hub/pending') return Response.json({ items: [approval], count: 1 });
    if (path.startsWith('/api/approval-hub/settled')) return Response.json({ items: [] });
    if (path === '/api/runtime-interactions/interaction-ui') return Response.json({ interaction: record(question) });
    throw new Error(`unexpected request ${path}`);
  });
  useApprovalHubStore.setState({
    items: [approval],
    count: 1,
    decisionAttempts: {},
    deciding: {},
    error: null,
    isLoading: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useApprovalHubStore.setState({ items: [], count: 0, decisionAttempts: {}, deciding: {} });
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
async function render(item: UnifiedAttentionItemV1, expanded = true) {
  await act(async () => root.render(<Wrapper item={item} expanded={expanded} />));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

describe.each(['zh', 'en'] as const)('expanded mailbox decisions (%s)', (language) => {
  const mention = (reason?: 'viewed' | 'replied' | 'ignored'): UnifiedAttentionItemV1 => ({
    decisionRef: 'mention:handled',
    kind: 'user_mention',
    summary: 'Controlled mention',
    linkedNeedsMe: [],
    userMention: {
      threadId: 'thread-original',
      threadTitle: 'Original discussion',
      messageId: 'message-original',
      catId: 'codex61-sol',
      timestamp: 1000,
      content: 'Controlled original body',
      handled: true,
      ...(reason ? { handledReason: reason, handledAt: 2000 } : {}),
    },
  });
  it.each([
    ['viewed', '看过', 'Viewed'],
    ['replied', '回了话', 'Replied'],
    ['ignored', '忽略', 'Ignored'],
  ] as const)('shows canonical %s completion on a collapsed history row', async (reason, zh, en) => {
    writeShellLanguage(language);
    await render(mention(reason), false);
    expect(container.querySelector('[data-testid="mailbox-mention-handled-reason"]')?.textContent).toBe(
      language === 'zh' ? zh : en,
    );
    expect(mocks.apiFetch.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
  it('does not assign a completion cause to older records without provenance', async () => {
    writeShellLanguage(language);
    await render(mention(), false);
    expect(container.querySelector('[data-testid="mailbox-mention-handled-reason"]')).toBeNull();
  });
  it('shows a named responsibility request with its Project, requester, and original Task action', async () => {
    writeShellLanguage(language);
    await render(accountability);
    expect(container.querySelector('[data-testid="mailbox-item"]')?.getAttribute('data-kind-label')).toBe(
      language === 'zh' ? '责任邀请' : 'Responsibility request',
    );
    expect(container.querySelector('[data-testid="mailbox-accountability-project"]')?.textContent).toContain(
      '共同项目',
    );
    expect(container.querySelector('[data-testid="mailbox-accountability-requester"]')?.textContent).toContain('You');
    expect(container.querySelector('[data-testid="mailbox-accountability-details"]')?.textContent).toContain(
      language === 'zh' ? '原项目任务' : 'original Project Task',
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mailbox-open-original"]')?.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(resolveOriginalPlace(accountability));
    expect(mocks.apiFetch.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
  it('localizes the F290 system result prompt without rewriting ordinary producer recommendations', async () => {
    writeShellLanguage(language);
    await render(collectiveResult);
    const expected =
      language === 'zh' ? '查看共同体工作中准备好的成果' : 'Review the prepared result in its Collective Work';
    expect(container.querySelector('[data-testid="mailbox-item-toggle"]')?.textContent).toContain(expected);
    expect(container.querySelector('[data-testid="mailbox-detail-recommendation"]')?.textContent).toContain(expected);
    if (language === 'zh') {
      expect(container.textContent).not.toContain('Review the prepared result in its Collective Work');
    }

    const ordinary = structuredClone(collectiveResult);
    ordinary.decisionRef = 'f292.repair:ordinary';
    ordinary.summary = '保留用户写下的建议';
    ordinary.linkedNeedsMe[0].receipt.producer.producerId = 'f292.repair';
    ordinary.linkedNeedsMe[0].receipt.reasonCode = 'repair_ready';
    ordinary.linkedNeedsMe[0].receipt.recommendation = ordinary.summary;
    await render(ordinary);
    expect(container.textContent).toContain('保留用户写下的建议');
  });
  it.each([
    { kind: 'approval', original: approvalRow(approval), expanded: true },
    { kind: 'choice', original: choice, expanded: true },
    { kind: 'choice', original: choice, expanded: false },
  ] as const)('shows the $kind title once (expanded=$expanded)', async ({ kind, original, expanded }) => {
    writeShellLanguage(language);
    const item = withCoordinate(original);
    await render(item, expanded);
    const body = container.querySelector<HTMLElement>('[data-testid="mailbox-item-body"]');
    expect(container.textContent?.split(item.summary).length).toBe(2);
    if (kind === 'choice') {
      expect(container.querySelector('[data-testid="mailbox-item-toggle"]')).toBeNull();
      expect([...(body?.querySelectorAll('h3') ?? [])].map((heading) => heading.textContent)).toEqual([item.summary]);
      expect(container.querySelector('[data-testid="mailbox-item"]')?.getAttribute('data-kind-label')).toBe(
        language === 'zh' ? '需要回答' : 'Question',
      );
      expect(body?.querySelector('select')).not.toBeNull();
      expect(body?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    } else {
      expect(container.querySelector('[data-testid="mailbox-item-toggle"]')?.textContent).toContain(item.summary);
      expect(body?.querySelectorAll('h3')).toHaveLength(0);
    }
  });
  it.each([
    ['approval', approvalRow(approval)],
    ['choice', choice],
  ] as const)('keeps both %s secondary actions in the decision footer, without writing a decision', async (_kind, original) => {
    writeShellLanguage(language);
    const item = withCoordinate(original);
    await render(item);
    const body = container.querySelector<HTMLElement>('[data-testid="mailbox-item-body"]');
    const ignore = body?.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-ignore"]');
    const open = body?.querySelector<HTMLButtonElement>('[data-testid="mailbox-open-original"]');
    const pair = ignore?.closest('[data-testid="mailbox-row-secondary-actions"]');
    expect(pair).toBeInstanceOf(HTMLElement);
    expect(pair?.contains(open ?? null)).toBe(true);
    const footer = pair?.parentElement;
    expect(footer?.querySelector('[data-testid="approve-btn"],button[type="submit"]')).not.toBeNull();
    await act(async () => {
      ignore?.click();
      open?.click();
    });
    expect(personal.change).toHaveBeenCalledExactlyOnceWith(item, false);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(resolveOriginalPlace(item));
    expect(mocks.apiFetch.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('keeps the original question label and required-answer guard with a theme primary submit', async () => {
    writeShellLanguage(language);
    await render(withCoordinate(choice));
    const select = container.querySelector<HTMLSelectElement>('select');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(container.querySelector('legend')?.textContent).toBe('Environment');
    expect(submit?.disabled).toBe(true);
    await act(async () => {
      if (select) setSelect(select, 'Alpha');
    });
    expect(submit?.disabled).toBe(false);
    expect(submit?.style.background).toBe('var(--shell-primary)');
    expect(submit?.style.color).toBe('var(--shell-primary-on)');
  });
});
