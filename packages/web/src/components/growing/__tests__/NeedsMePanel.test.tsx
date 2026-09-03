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
  return {
    envelope: {
      subjectRef,
      ownerRef: 'task:item:tomorrow-ppt',
      sourceRefs: ['message:thread-ppt:message-source'],
      revision: 4,
      freshness: { state: 'current', observedRevision: 4 },
      visibility: { ownerUserId: 'owner-1', human: true, cat: true },
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
              ownerRef: 'interaction:ppt-direction',
              subjectRef: 'interaction:ppt-direction',
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
    expect(items[0]?.textContent).toContain('已可查看');
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
