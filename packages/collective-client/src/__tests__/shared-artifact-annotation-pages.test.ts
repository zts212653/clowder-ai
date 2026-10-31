import { expect, it } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import { collectiveArtifactClient } from '../collective-artifact-client.js';
import { annotationArtifact, annotationView } from './shared-artifact-annotation-pages.fixture.js';

it('reads only the initial annotation page, then explicitly reads exactly one more page of the same owner ledger', async () => {
  const offsets: number[] = [];
  const request: ClientRequest = async <Result>(_path: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    const offset = input.payload.annotationOffset ?? 0;
    offsets.push(offset);
    if (offset) expect(input.ownerRevision).toBe(1);
    return { value: annotationView(offset) } as Result;
  };
  const api = collectiveArtifactClient(request, annotationArtifact, 'reader');
  const first = await api.read(annotationArtifact);
  expect(offsets).toEqual([0]);
  expect(first.view.review.annotations).toHaveLength(2);
  const all = await api.moreAnnotations(annotationArtifact, first);
  expect(offsets).toEqual([0, 2]);
  expect(all.view.review.annotations.map((note) => note.id)).toEqual(['annotation-0', 'annotation-1', 'annotation-2']);
  expect(all.view.replyPages?.map((page) => page.annotationId)).toEqual([
    'annotation-0',
    'annotation-1',
    'annotation-2',
  ]);
  expect(all.view.annotationPage.nextOffset).toBeUndefined();
  expect(first.view.review.annotations).toHaveLength(2);
});

for (const drift of ['ledger', 'source', 'offset', 'total', 'duplicate', 'skipped', 'unfinished'] as const)
  it(`refuses ${drift} drift instead of displaying mixed or incomplete annotation pages`, async () => {
    const request: ClientRequest = async <Result>() => {
      const page = annotationView(2);
      if (drift === 'ledger') page.view.review.reviewId = 'other-ledger';
      if (drift === 'source') page.contentRef = 'other-content';
      if (drift === 'offset') page.view.annotationPage.offset = 1;
      if (drift === 'total') page.view.annotationPage.total = 4;
      if (drift === 'duplicate') page.view.review.annotations[0].id = 'annotation-0';
      if (drift === 'skipped') page.view.annotationPage.nextOffset = 4;
      if (drift === 'unfinished') page.view.review.annotations = [];
      return { value: page } as Result;
    };
    const api = collectiveArtifactClient(request, annotationArtifact, 'reader');
    await expect(api.moreAnnotations(annotationArtifact, annotationView())).rejects.toThrow('批注');
  });
