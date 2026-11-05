// @vitest-environment jsdom
import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkSubmissionRecovery } from '../WorkSubmissionRecovery';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('never resolves on mount, and an unconfirmed resolution retries its identical original operation without losing the page', async () => {
  const view = {
    review: { reviewId: 'original-review', task: { threadId: 'original-thread' } },
    pendingSubmission: {
      kind: 'work-submit-response',
      operationId: 'director-submit',
      sourceRound: 1,
      expectedReviewRevision: 7,
    },
  } as ArtifactReviewView;
  const refresh = vi.fn(async () => undefined);
  const node = document.createElement('div');
  const root = createRoot(node);
  mock.fetch
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(new Response('{"status":"aborted"}'));
  try {
    await act(async () => root.render(<WorkSubmissionRecovery view={view} onRecovered={refresh} />));
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(node.textContent).toContain('已保存的版本会保留');
    const button = node.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(refresh).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('重试');
    await act(async () => button?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mock.fetch.mock.calls[0]?.[1]?.body).toBe(mock.fetch.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(mock.fetch.mock.calls[0]?.[1]?.body)).toMatchObject({
      threadId: 'original-thread',
      command: {
        action: 'resolve-review-submission',
        reviewId: 'original-review',
        pendingOperationId: 'director-submit',
        sourceRound: 1,
        expectedReviewRevision: 7,
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
