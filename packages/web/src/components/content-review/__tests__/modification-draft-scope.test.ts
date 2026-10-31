import type { ContentModificationRequest } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import type { ModificationDraft } from '../modification-draft';
import { modificationSourceVersion } from '../modification-draft';
import { rebaseModificationDraft } from '../modification-draft-scope';

const source: ContentModificationRequest['source'] = {
  kind: 'publication',
  contentRef: `prepared-media:${'a'.repeat(64)}`,
  ownerRevision: 2,
  ledgerRef: 'ledger',
  expectedLedgerRevision: 1,
};
const draft: ModificationDraft = {
  v: 1,
  sourceVersion: modificationSourceVersion({ ...source, ownerRevision: 1 }),
  body: '保留背景',
  targetCatId: 'opus5',
  threadId: 'original',
  acceptOperations: {},
  intent: { imageEdit: { kind: 'erase-region', region: { x: 1, y: 2, width: 3, height: 4 } } },
};
it('an erase request binds only a newly captured region; it never carries old image coordinates into the next version', () => {
  expect(rebaseModificationDraft(draft, source)).toBeNull();
  expect(
    rebaseModificationDraft(draft, source, {
      sourceVersion: modificationSourceVersion(source),
      intent: { selection: { kind: 'image-point', x: 8, y: 9 } },
    }),
  ).toBeNull();
  const region = { x: 10, y: 20, width: 30, height: 40 };
  const next = rebaseModificationDraft(draft, source, {
    sourceVersion: modificationSourceVersion(source),
    intent: { selection: { kind: 'image-region', ...region } },
  });
  expect(next?.intent?.imageEdit).toEqual({ kind: 'erase-region', region });
  expect(next?.previousScopes?.[0]?.intent).toEqual(draft.intent);
  expect(draft.intent?.imageEdit).not.toEqual(next?.intent?.imageEdit);
});
it('whole-work aspect ratio instructions can be explicitly retained without inventing a spatial selection', () => {
  const next = rebaseModificationDraft(
    { ...draft, intent: { imageEdit: { kind: 'aspect-ratio', ratio: '16:9' } } },
    source,
  );
  expect(next?.intent).toEqual({ imageEdit: { kind: 'aspect-ratio', ratio: '16:9' } });
  expect(next?.body).toBe(draft.body);
});
