import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CharacterAssetBinding } from '@cat-cafe/shared';
import { canonCat, canonFixture, canonHuman, canonReference } from './helpers/asset-canon-fixture.js';

test('global supersession atomically requires every use disposition with pre-command asset CAS', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const avatar = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 'series-a',
    role: 'avatar' as const,
  };
  const portrait = { ...avatar, role: 'portrait' as const };
  const a = await f.mark(await f.image('a.png', 'a', [avatar, portrait]));
  const b = await f.mark(await f.image('b.png', 'b', [avatar, portrait]));
  const bind = async (slot: typeof avatar | typeof portrait, op: string) => {
    const command = {
      action: 'bind-character-asset',
      mode: 'set',
      slot,
      indexedVersionRef: a.indexedVersionRef,
      expectedAssetRevision: a.revision,
      expectedBindingRevision: 0,
      reason: '原始 Human 选择',
      evidenceRefs: ['human:source'],
      operationId: op,
    };
    await assert.rejects(f.service.run(command, canonCat), /access_denied/);
    return ((await f.service.run(command, canonHuman)) as { bindings: CharacterAssetBinding[] }).bindings[0]!;
  };
  const first = await bind(avatar, 'avatar');
  const second = await bind(portrait, 'portrait');
  const base = {
    action: 'supersede-asset',
    mode: 'replace',
    fromVersionRef: a.indexedVersionRef,
    toVersionRef: b.indexedVersionRef,
    expectedFromRevision: a.revision,
    expectedToRevision: b.revision,
    reason: '新正典明确接替这两个用途',
    operationId: 'replace-two-uses',
  };
  const move = (binding: CharacterAssetBinding) => ({
    bindingRef: binding.bindingRef,
    expectedBindingRevision: 1,
    indexedVersionRef: b.indexedVersionRef,
    expectedAssetRevision: b.revision,
    reason: '推进这项用途',
  });
  await assert.rejects(f.service.run({ ...base, bindings: [move(first)] }, canonHuman), /Every affected/);
  assert.equal(f.store.works.assets.get('owner', a.indexedVersionRef)!.supersededBy, null);
  const complete = { ...base, bindings: [move(first), move(second)] };
  await f.service.run(complete, canonHuman);
  assert.equal(f.store.works.assets.binding('owner', first.bindingRef)!.indexedVersionRef, b.indexedVersionRef);
  assert.equal(f.store.works.assets.binding('owner', second.bindingRef)!.indexedVersionRef, b.indexedVersionRef);
  await assert.rejects(f.mark(b, 'failed'), /Every affected/);
});

test('binding citations retain their exact selection and keeping one use never hides another', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const use = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 's',
    role: 'portrait' as const,
  };
  const a = await f.mark(await f.image('a.png', 'a', [use]));
  const b = await f.mark(await f.image('b.png', 'b', [use]));
  const bind = {
    action: 'bind-character-asset',
    mode: 'set',
    slot: use,
    expectedBindingRevision: 0,
    indexedVersionRef: a.indexedVersionRef,
    expectedAssetRevision: a.revision,
    reason: '选定立绘',
    evidenceRefs: ['human:original'],
    operationId: 'bind-a',
  };
  const binding = ((await f.service.run(bind, canonHuman)) as { bindings: CharacterAssetBinding[] }).bindings[0]!;
  const selection = { bindingRef: binding.bindingRef, bindingRevision: 1, indexedVersionRef: a.indexedVersionRef };
  const metadata = await f.use([a], canonReference, selection);
  f.service.assertSelections(metadata.context, 'owner');
  await f.service.run(
    {
      ...bind,
      indexedVersionRef: b.indexedVersionRef,
      expectedAssetRevision: b.revision,
      expectedBindingRevision: 1,
      operationId: 'bind-b',
    },
    canonHuman,
  );
  assert.throws(() => f.service.assertSelections(metadata.context, 'owner'), /selection changed/);
  const checked = (await f.service.run({ action: 'check-asset-updates', reference: canonReference }, canonCat)) as {
    updates: { noticeScope: string }[];
  };
  assert.equal(checked.updates.length, 1);
  assert.equal(checked.updates[0]!.noticeScope, binding.bindingRef);
  assert.equal(f.store.works.assets.get('owner', a.indexedVersionRef)!.supersededBy, null);
});

test('an unrelated index update preserves an old film’s authenticated binding selection after the current binding moves', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const slot = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 's',
    role: 'portrait' as const,
  };
  const a = await f.mark(await f.image('a.png', 'a', [slot]));
  const b = await f.mark(await f.image('b.png', 'b', [slot]));
  const command = {
    action: 'bind-character-asset',
    mode: 'set',
    slot,
    expectedBindingRevision: 0,
    indexedVersionRef: a.indexedVersionRef,
    expectedAssetRevision: a.revision,
    reason: '原选择',
    evidenceRefs: ['human:original'],
    operationId: 'bind-old',
  };
  const binding = ((await f.service.run(command, canonHuman)) as { bindings: CharacterAssetBinding[] }).bindings[0]!;
  const selection = { bindingRef: binding.bindingRef, bindingRevision: 1, indexedVersionRef: a.indexedVersionRef };
  await f.use([a], canonReference, selection);
  await f.service.run(
    {
      ...command,
      operationId: 'bind-new',
      expectedBindingRevision: 1,
      indexedVersionRef: b.indexedVersionRef,
      expectedAssetRevision: b.revision,
    },
    canonHuman,
  );
  const unchanged = await f.use([a], canonReference, selection);
  assert.deepEqual(unchanged.context.assets[0]!.bindingSelection, selection);
  await assert.rejects(f.use([a], { ...canonReference, ownerRevision: 2 }, selection), /binding selection changed/);
});

test('keeping one binding notice leaves another use pending; source-use changes re-prompt while subtitle changes do not', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const avatar = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 's',
    role: 'avatar' as const,
  };
  const portrait = { ...avatar, role: 'portrait' as const };
  const a = await f.mark(await f.image('a.png', 'a', [avatar, portrait]));
  const b = await f.mark(await f.image('b.png', 'b', [avatar, portrait]));
  const bind = async (slot: typeof avatar | typeof portrait, to: typeof a, expected: number, op: string) =>
    (
      (await f.service.run(
        {
          action: 'bind-character-asset',
          mode: 'set',
          slot,
          expectedBindingRevision: expected,
          indexedVersionRef: to.indexedVersionRef,
          expectedAssetRevision: to.revision,
          reason: '明确选择',
          evidenceRefs: ['human:source'],
          operationId: op,
        },
        canonHuman,
      )) as { bindings: CharacterAssetBinding[] }
    ).bindings[0]!;
  const av = await bind(avatar, a, 0, 'av-a'),
    po = await bind(portrait, a, 0, 'po-a');
  const base = await f.use([a]);
  const rows = [av, po].map((binding, index) => ({
    ...base.context.assets[0]!,
    asset: { ...base.context.assets[0]!.asset, id: `use-${index}` },
    uses: [`part-${index}`],
    bindingSelection: { bindingRef: binding.bindingRef, bindingRevision: 1, indexedVersionRef: a.indexedVersionRef },
  }));
  let context = { ...base.context, assets: rows };
  let revision = 1;
  const save = () =>
    f.contexts.save(
      {
        action: 'set-context',
        reference: canonReference,
        operationId: `metadata-${revision}`,
        expectedMetadataRevision: revision++,
        context,
      },
      canonCat,
    );
  await save();
  await bind(avatar, b, 1, 'av-b');
  await bind(portrait, b, 1, 'po-b');
  const check = () =>
    f.service.run({ action: 'check-asset-updates', reference: canonReference }, canonCat) as Promise<{
      updates: { noticeScope: string; updateFingerprint: string }[];
      kept: unknown[];
    }>;
  const first = await check();
  assert.equal(first.updates.length, 2);
  const notice = first.updates.find((n) => n.noticeScope === av.bindingRef)!;
  await f.service.run(
    {
      action: 'decide-asset-update',
      reference: canonReference,
      indexedVersionRef: a.indexedVersionRef,
      noticeScope: notice.noticeScope,
      updateFingerprint: notice.updateFingerprint,
      expectedDecisionRevision: 0,
      decision: 'keep_this_version',
      reason: '只保留这版头像引用',
      operationId: 'keep-avatar-use',
    },
    canonHuman,
  );
  assert.equal((await check()).updates.length, 1);
  assert.equal((await check()).kept.length, 1);
  context = { ...context, story: [{ id: 'subtitle', title: '补字幕', streamId: 'v', startPts: 0, endPts: 10 }] };
  await save();
  assert.equal((await check()).updates.length, 1);
  context = {
    ...context,
    assets: context.assets.map((row, i) => (i === 0 ? { ...row, uses: ['different-part'] } : row)),
  };
  await save();
  assert.equal((await check()).updates.length, 2);
});

test('a cleared purpose remains discoverable with its CAS revision so a Human can explicitly select it again', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const slot = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 'series',
    role: 'portrait' as const,
  };
  const a = await f.mark(await f.image('a.png', 'a', [slot]));
  const command = {
    action: 'bind-character-asset',
    mode: 'set',
    slot,
    indexedVersionRef: a.indexedVersionRef,
    expectedAssetRevision: a.revision,
    expectedBindingRevision: 0,
    reason: '明确选择',
    evidenceRefs: ['source'],
    operationId: 'initial',
  };
  await f.service.run(command, canonHuman);
  await f.service.run(
    {
      ...command,
      mode: 'clear',
      indexedVersionRef: undefined,
      expectedAssetRevision: undefined,
      expectedBindingRevision: 1,
      operationId: 'clear',
    },
    canonHuman,
  );
  const result = (await f.service.run({ action: 'list-assets', use: slot }, canonHuman)) as {
    items: unknown[];
    binding?: { bindingRef: string; bindingRevision: number };
  };
  assert.equal(result.items.length, 0);
  assert.equal(result.binding?.bindingRevision, 2);
  await f.service.run(
    { ...command, expectedBindingRevision: result.binding!.bindingRevision, operationId: 'select-again' },
    canonHuman,
  );
  assert.equal(
    f.store.works.assets.binding('owner', result.binding!.bindingRef)!.indexedVersionRef,
    a.indexedVersionRef,
  );
});
