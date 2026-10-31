import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const { acceptContentResult } = await import('../accept-content-result');

const input = {
  requestId: 'request-1',
  candidateRef: 'candidate-1',
  acceptOperationId: 'accept-1',
  source: { locator: { worktreeId: 'work', path: 'drinks.md' }, expectedSourceRevision: `sha256:${'a'.repeat(64)}` },
};

function view(receipt?: { state: 'applied' | 'unknown'; writtenRevision?: string }): ContentModificationDetailView {
  return {
    acceptances: [
      {
        acceptance: {
          acceptOperationId: 'accept-1',
          candidateRef: 'candidate-1',
          baseRevision: input.source.expectedSourceRevision,
        },
        ...(receipt ? { receipt } : {}),
      },
    ],
  } as unknown as ContentModificationDetailView;
}

describe('acceptContentResult', () => {
  it('returns the revision the accepted write produced, so the review can be fenced to it', async () => {
    const written = `sha256:${'b'.repeat(64)}`;
    const refresh = vi.fn(async () => view({ state: 'applied', writtenRevision: written }));
    await expect(acceptContentResult(input, refresh)).resolves.toEqual({ writtenRevision: written });
  });

  it('keeps an applied write without a recorded revision distinguishable from "not applied"', async () => {
    const refresh = vi.fn(async () => view({ state: 'applied' }));
    await expect(acceptContentResult(input, refresh)).resolves.toEqual({ writtenRevision: undefined });
  });
});
