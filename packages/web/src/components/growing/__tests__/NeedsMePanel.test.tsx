import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  refetch: vi.fn(),
}));

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api-client')>()),
  apiFetch: api.apiFetch,
}));

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: (projection: string) => {
    if (projection !== 'needs-me') throw new Error(`unexpected projection: ${projection}`);
    return mocks;
  },
}));

import { NeedsMePanel, needsMeItemRef } from '../NeedsMePanel';
import { selectNeedsMeItems } from '../needs-me-items';

const artifacts: GlobalArtifactDTO[] = [
  {
    type: 'file',
    name: 'Tomorrow partner presentation.pptx',
    catId: 'codex-sol',
    createdAt: 700,
    sourceMessageId: 'message-artifact',
    ref: 'artifact:ppt:tomorrow',
    threadId: 'thread-ppt',
    threadTitle: 'Partner presentation',
  },
];

function ownerRead(input: { eligible: boolean; producerRevision?: number }): EntrustedWorkOwnerReadV1 {
  const producerRevision = input.producerRevision ?? 11;
  const subjectRef = 'task:work:tomorrow-ppt';
  const ownerRef = 'task:item:tomorrow-ppt';
  const producerRef = 'interaction:ppt-direction';
  return {
    envelope: {
      subjectRef,
      ownerRef,
      admissionReceiptRef: 'task:receipt:tomorrow-ppt:4',
      sourceRefs: ['message:thread-ppt:message-source'],
      revision: 4,
      freshness: { state: 'current', observedRevision: 4 },
      visibility: { ownerUserId: 'owner-1', human: true, cat: true },
    },
    brief: {
      outcome: {
        state: 'known',
        value: 'A reviewable presentation for tomorrow',
        ownerRef,
        revision: 4,
      },
      current: { state: 'doing', ownerRef, revision: 4 },
      verifiedMilestone: input.eligible
        ? { kind: 'needs_judgment', evidenceRef: producerRef, revision: producerRevision }
        : {
            kind: 'artifact_ready',
            evidenceRef: 'message:thread-ppt:message-artifact#available:700',
            revision: '700',
          },
      nextOwner: input.eligible
        ? {
            kind: 'human',
            ownerRef: 'user:owner-1',
            evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: producerRevision }],
          }
        : { kind: 'cat', ownerRef: 'cat:codex-sol', evidenceRef: ownerRef, revision: 4 },
      needsMe: input.eligible
        ? {
            state: 'needed',
            evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: producerRevision }],
          }
        : { state: 'not_needed', evidenceRef: ownerRef, revision: 4 },
    },
    preparedArtifact: {
      artifactRef: 'artifact:ppt:tomorrow',
      artifactRevision: '700',
      completenessRef: 'message:thread-ppt:message-artifact#available:700',
      previewRef: 'message:thread-ppt:message-artifact#preview:700',
      openInWorkspaceRef: 'workspace:artifact:thread-ppt:700:artifact:ppt:tomorrow',
    },
    timeRefs: [],
    attentionReceipts: [
      input.eligible
        ? {
            eligible: true,
            producer: {
              producerId: 'f306.runtime_interaction',
              ownerRef: producerRef,
              subjectRef: producerRef,
              revision: producerRevision,
            },
            taskRef: { subjectRef, observedRevision: 4 },
            kind: 'judgment',
            reasonCode: 'runtime_interaction:choice',
            recommendation: 'Use the evidence-first storyline',
            salience: 'normal',
            action: {
              actionRef: 'message:thread-ppt:message-question#block-direction',
              expectedProducerRevision: producerRevision,
            },
            reEvaluateActionRef: 'interaction:ppt-direction#reevaluate',
          }
        : {
            eligible: false,
            producer: {
              producerId: 'f306.runtime_interaction',
              ownerRef: 'interaction:ppt-direction',
              subjectRef: 'interaction:ppt-direction',
              revision: producerRevision,
            },
            taskRef: { subjectRef, observedRevision: 4 },
            reEvaluateActionRef: 'interaction:ppt-direction#reevaluate',
          },
    ],
  };
}

describe('F310 NeedsMePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.ownerReads = [];
    mocks.loading = false;
    mocks.error = false;
    mocks.refetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('derives the global count from the same visible-item predicate as the panel', () => {
    const withoutArtifact = { ...ownerRead({ eligible: true }), preparedArtifact: undefined };
    expect(
      selectNeedsMeItems([ownerRead({ eligible: false }), withoutArtifact, ownerRead({ eligible: true })]),
    ).toHaveLength(1);
  });

  it('explains the quiet state in the user situation without internal design commentary', async () => {
    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });

    expect(container.textContent).toContain('猫会先把能做的做好；只有真的需要你决定时，才带着准备好的内容回来。');
    expect(container.textContent).not.toContain('原 owner');
    expect(container.textContent).not.toContain('Schedule');
    expect(container.textContent).not.toContain('不复制一份审批状态');

    const headline = [...container.querySelectorAll('p')].find((p) => p.textContent === '暂时没有要你判断的事');
    expect(headline?.className).toContain('text-[length:var(--console-font-2xl)]');
    expect(headline?.className).toContain('leading-[1.25]');
    expect(headline?.getAttribute('style') ?? '').not.toContain('font-size');
  });

  it('points the quiet state at the work calendar as its real next destination', async () => {
    const previousMode = useChatStore.getState().workspaceMode;
    try {
      await act(async () => {
        root.render(<NeedsMePanel artifacts={artifacts} />);
      });
      expect(container.textContent).toContain('工作安排和进展都在工作日历。');
      const exit = container.querySelector('[data-testid="needs-me-goto-schedule"]');
      expect(exit?.textContent).toContain('去工作日历看看');
      expect(container.textContent).toContain('刷新');

      await act(async () => {
        exit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(useChatStore.getState().workspaceMode).toBe('product-schedule');
    } finally {
      useChatStore.setState({ workspaceMode: previousMode });
    }
  });

  it('withholds the count while the read is loading or failed instead of fabricating zero', async () => {
    mocks.loading = true;
    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });
    expect(container.textContent).toContain('Needs Me');
    expect(container.querySelector('[data-testid="needs-me-count"]')).toBeNull();

    mocks.loading = false;
    mocks.error = true;
    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });
    expect(container.querySelector('[data-testid="needs-me-count"]')).toBeNull();

    mocks.error = false;
    mocks.ownerReads = [ownerRead({ eligible: true })];
    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });
    expect(container.querySelector('[data-testid="needs-me-count"]')?.textContent).toBe('1');
  });

  it('keeps an unavailable read honest and recoverable without exposing owner internals', async () => {
    mocks.error = true;

    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });

    expect(container.textContent).toContain('暂时无法读取需要你判断的事');
    expect(container.textContent).toContain('任务和准备好的内容仍然保留');
    expect(container.textContent).toContain('请稍后刷新');
    expect(container.textContent).not.toContain('owner truth');
  });

  it('renders exactly the current producer judgment with prepared Artifact truth', async () => {
    mocks.ownerReads = [ownerRead({ eligible: false }), ownerRead({ eligible: true })];
    const onOpenArtifact = vi.fn();
    const onOpenAction = vi.fn();

    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} onOpenArtifact={onOpenArtifact} onOpenAction={onOpenAction} />);
    });

    const items = container.querySelectorAll('[data-testid="needs-me-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('为什么现在需要你');
    expect(items[0]?.textContent).toContain('Use the evidence-first storyline');
    expect(items[0]?.textContent).toContain('Tomorrow partner presentation.pptx');
    // Technical coordinates live only in the collapsed details, never in the card's main text.
    expect(items[0]?.textContent).not.toContain('Artifact r700');
    expect(items[0]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe(
      'Tomorrow partner presentation.pptx',
    );
    expect(items[0]?.querySelector('[data-testid="entrusted-work-brief"] details')?.textContent).toContain(
      'artifact:ppt:tomorrow',
    );
    expect(items[0]?.textContent).toContain('已可查看');
    expect(items[0]?.textContent).toContain('A reviewable presentation for tomorrow');
    expect(items[0]?.textContent).toContain('已到需要你判断的节点');
    expect(items[0]?.textContent).toContain('You');
    expect(items[0]?.textContent).toContain('需要你吗');
    expect(items[0]?.textContent).toContain('准备好的内容');
    expect(items[0]?.textContent).toContain('现在需要你');
    // Producer reason codes fold behind a summary; they never sit inline in the card text.
    expect(items[0]?.textContent).not.toContain('来源判断：runtime_interaction:choice');
    const reasonSummary = Array.from(items[0]?.querySelectorAll('summary') ?? []).find((summary) =>
      summary.textContent?.includes('来源判断'),
    );
    expect(reasonSummary?.parentElement?.textContent).toContain('runtime_interaction:choice');
    expect(items[0]?.getAttribute('data-producer-revision')).toBe('11');

    await act(async () => {
      container
        .querySelector('[data-testid="needs-me-open-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactRef: 'artifact:ppt:tomorrow', artifactRevision: '700' }),
      expect.stringContaining('task:work:tomorrow-ppt'),
      undefined, // an F232 artifact has no review title to carry into the tab
    );

    await act(async () => {
      container
        .querySelector('[data-testid="needs-me-open-action"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenAction).toHaveBeenCalledWith(
      'message:thread-ppt:message-question#block-direction',
      expect.stringContaining('interaction:ppt-direction'),
    );
  });

  it('keeps an unknown producer reason code verbatim behind the fold instead of translating it', async () => {
    const read = ownerRead({ eligible: true });
    const receipt = read.attentionReceipts[0];
    if (!receipt?.eligible) throw new Error('fixture receipt missing');
    receipt.reasonCode = 'future_producer:unseen_code';
    mocks.ownerReads = [read];

    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });

    const item = container.querySelector('[data-testid="needs-me-item"]');
    expect(item?.textContent).not.toContain('来源判断：future_producer:unseen_code');
    const reasonSummary = Array.from(item?.querySelectorAll('summary') ?? []).find((summary) =>
      summary.textContent?.includes('来源判断'),
    );
    expect(reasonSummary?.parentElement?.textContent).toContain('future_producer:unseen_code');
  });

  it('titles a content-review artifact by the review, not by its upload path', async () => {
    // Real page 2026-09-23: a cat-prepared review of a chat upload showed
    // "/uploads/1790177165901-f550062c.png" as the card title and brief artifact.
    const reviewId = `review-${'a'.repeat(64)}`;
    const read = ownerRead({ eligible: true });
    read.preparedArtifact = {
      artifactRef: '/uploads/1790177165901-f550062c.png',
      artifactRevision: '1',
      completenessRef: 'content-receipt-1',
      previewRef: `content-review:${reviewId}:round:1`,
      openInWorkspaceRef: `workspace:content-review:thread-ppt:${reviewId}`,
    };
    mocks.ownerReads = [read];
    api.apiFetch.mockImplementation(async (url: string) =>
      url.endsWith('/media/1')
        ? new Response(new Blob(['png-bytes'], { type: 'image/png' }))
        : new Response(JSON.stringify({ review: { reviewId, title: '判断弹窗文案是否清楚' } }), {
            headers: { 'content-type': 'application/json' },
          }),
    );
    const createObjectURL = vi.fn(() => 'blob:review-thumb');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));

    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const item = container.querySelector('[data-testid="needs-me-item"]');
    const preview = item?.querySelector('[data-testid="prepared-artifact-preview"]');
    expect(preview?.textContent).toContain('判断弹窗文案是否清楚');
    expect(preview?.textContent).toContain('第 1 版');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('blob:review-thumb');
    expect(item?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe(
      '判断弹窗文案是否清楚 · 第 1 版',
    );
    const visible = item?.cloneNode(true) as HTMLElement;
    for (const details of visible.querySelectorAll('details')) details.remove();
    expect(visible.textContent).not.toContain('/uploads/');
    expect(api.apiFetch).toHaveBeenCalledWith(`/api/artifact-reviews/${reviewId}`, expect.anything());
    vi.unstubAllGlobals();
  });

  it('preserves the exact selected item coordinate without owning judgment state', async () => {
    const read = ownerRead({ eligible: true, producerRevision: 12 });
    const receipt = read.attentionReceipts[0];
    if (!receipt) throw new Error('fixture receipt missing');
    const selectedItemRef = needsMeItemRef(read, receipt);
    mocks.ownerReads = [read];

    await act(async () => {
      root.render(<NeedsMePanel artifacts={artifacts} selectedItemRef={selectedItemRef} />);
    });

    const item = container.querySelector('[data-testid="needs-me-item"]');
    expect(item?.getAttribute('data-item-ref')).toBe(selectedItemRef);
    expect(item?.getAttribute('data-selected')).toBe('true');
    expect(item?.getAttribute('data-task-revision')).toBe('4');
    expect(item?.getAttribute('data-producer-revision')).toBe('12');
  });
});
