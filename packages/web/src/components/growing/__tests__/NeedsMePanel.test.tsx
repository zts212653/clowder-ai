import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  refetch: vi.fn(),
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
    expect(container.textContent).toContain('暂时没有要你判断的事');
    expect(container.textContent).not.toContain('原 owner');
    expect(container.textContent).not.toContain('Schedule');
    expect(container.textContent).not.toContain('不复制一份审批状态');
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
    expect(items[0]?.textContent).toContain('Artifact r700');
    expect(items[0]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toContain(
      'artifact:ppt:tomorrow',
    );
    expect(items[0]?.textContent).toContain('已可查看');
    expect(items[0]?.textContent).toContain('A reviewable presentation for tomorrow');
    expect(items[0]?.textContent).toContain('已到需要你判断的节点');
    expect(items[0]?.textContent).toContain('You');
    expect(items[0]?.textContent).toContain('现在需要你');
    expect(items[0]?.getAttribute('data-producer-revision')).toBe('11');

    await act(async () => {
      container
        .querySelector('[data-testid="needs-me-open-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactRef: 'artifact:ppt:tomorrow', artifactRevision: '700' }),
      expect.stringContaining('task:work:tomorrow-ppt'),
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
