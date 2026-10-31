import type { ContentModificationCandidate, ReviewedMediaAsset } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationCandidatePreview } from '../ContentModificationCandidatePreview';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: async () => new Response(new Blob(['png'])),
}));

const original: ReviewedMediaAsset = {
  contentRef: 'published-picture',
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 390, height: 844 },
  sourcePublication: { artifactRef: '/uploads/original.png', sourceRef: 'message:source', revision: '1' },
  ownerReceiptRef: 'receipt:original',
};
const candidate: ContentModificationCandidate = {
  kind: 'media',
  candidateRef: 'candidate:2',
  authorCatId: 'codex61-sol',
  responses: [],
  asset: { ...original, ownerRevision: 2, blobDigest: `sha256:${'b'.repeat(64)}` },
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:png');
      static revokeObjectURL = vi.fn();
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('compares the exact original and returned PNG without replacing the original by the candidate', async () => {
  const props = { candidate, original };
  await act(async () => {
    root.render(<ContentModificationCandidatePreview {...props} />);
  });
  expect(container.querySelector('[aria-label="原版"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="候选版本"]')).not.toBeNull();
  expect(container.textContent).toContain('v1');
  expect(container.textContent).toContain('v2');
});
