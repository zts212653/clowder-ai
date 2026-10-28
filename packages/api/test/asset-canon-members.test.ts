import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssetCanonItem } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { MemberCanonService } from '../src/domains/collaborative-content/asset-canon/member-service.js';
import { canonCat, canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

test('member avatar uses a unique Human-owned slot, keeps clear linked, and preserves it after reopening F309', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const members = new MemberCanonService(f.service, 'owner');
  const purpose = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'cat',
    styleKey: 'family',
    role: 'avatar' as const,
  };
  const avatar = await f.mark(await f.image('avatar.png', 'a', [purpose]));
  await f.mark(await f.image('failed.png', 'b', [purpose]), 'failed');
  await f.mark(await f.image('other.png', 'c', [{ ...purpose, subjectRef: { kind: 'member', catId: 'other-cat' } }]));
  await f.mark(await f.image('walk.png', 'd', [{ ...purpose, role: 'action', actionKey: 'walk' }]));
  const candidates = (await f.service.run({ action: 'list-assets', memberAvatarCatId: 'director' }, canonHuman)) as {
    items: AssetCanonItem[];
  };
  assert.deepEqual(
    candidates.items.map((i) => i.record.name),
    ['avatar.png'],
  );
  assert.equal((await members.project('director', canonHuman)).visualAssets.state, 'unlinked');
  const selection = {
    operationId: 'choose-avatar',
    mode: 'set' as const,
    indexedVersionRef: avatar.indexedVersionRef,
    expectedAssetRevision: avatar.revision,
    expectedBindingRevision: 0,
    reason: '使用已确认头像',
  };
  await assert.rejects(members.select('director', selection, canonCat), /access_denied/);
  await members.select('director', selection, canonHuman);
  const selected = await members.project('director', canonHuman);
  assert.equal(selected.visualAssets.state, 'selected');
  assert.match(selected.avatar!, /\/api\/cats\/director\/avatar\?bindingRevision=1/);
  const reopened = new ArtifactReviewStore(f.dbPath);
  try {
    assert.equal(
      reopened.works.assets.binding('owner', selected.visualAssets.bindingRef!)!.indexedVersionRef,
      avatar.indexedVersionRef,
    );
  } finally {
    reopened.close();
  }
  await unlink(join(f.root, 'avatar.png'));
  assert.equal((await members.project('director', canonHuman)).visualAssets.state, 'unavailable');
  await members.select(
    'director',
    { operationId: 'clear-avatar', mode: 'clear', expectedBindingRevision: 1, reason: '暂不选图' },
    canonHuman,
  );
  assert.equal((await members.project('director', canonHuman)).visualAssets.state, 'cleared');
  assert.ok(members.binding('director'));
  assert.equal((await members.history('director', canonHuman)).length, 2);
});

test('avatar upload retains its three receipts without forwarding transport-only fields into a strict bind command', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const members = new MemberCanonService(f.service, 'owner');
  const source = await f.image('uploaded.png', 'upload', [
    {
      subjectRef: { kind: 'member', catId: 'director' },
      representation: 'member-avatar',
      styleKey: 'member-settings',
      role: 'avatar',
    },
  ]);
  const input = {
    operationId: 'upload-pipeline',
    reason: '原文件已选择',
    expectedBindingRevision: 0,
    uploadUrl: '/uploads/avatar-1793016139660-3f79e0c6.png',
  };
  const result = await members.upload('director', input, { name: source.name, version: source.version }, canonHuman);
  assert.equal(result.status, 'saved');
  assert.equal((await members.project('director', canonHuman)).visualAssets.state, 'selected');
  assert.deepEqual(
    await members.upload('director', input, { name: source.name, version: source.version }, canonHuman),
    result,
  );
});

test('an already indexed material can acquire an explicit candidate purpose; removing a selected purpose needs a Human disposition', async (t) => {
  const f = await canonFixture();
  t.after(f.cleanup);
  const members = new MemberCanonService(f.service, 'owner');
  const original = await f.image('existing.png');
  const use = {
    subjectRef: { kind: 'member' as const, catId: 'director' },
    representation: 'member-avatar',
    styleKey: 'family',
    role: 'avatar' as const,
  };
  const command = {
    action: 'set-asset-status',
    indexedVersionRef: original.indexedVersionRef,
    expectedRevision: 0,
    status: 'canonical',
    applicability: [use],
    reason: '按原选择证据补登记头像用途',
    evidenceRefs: ['human:character-bible'],
    operationId: 'classify-existing',
  };
  const result = (await f.service.run(command, canonHuman)) as { assets: (typeof original)[] };
  const current = result.assets[0]!;
  assert.deepEqual(current.applicability, [use]);
  await members.select(
    'director',
    {
      operationId: 'select-classified',
      mode: 'set',
      reason: '原选择',
      expectedBindingRevision: 0,
      indexedVersionRef: current.indexedVersionRef,
      expectedAssetRevision: current.revision,
    },
    canonHuman,
  );
  await assert.rejects(
    f.service.run(
      { ...command, operationId: 'remove-purpose', expectedRevision: current.revision, applicability: [] },
      canonHuman,
    ),
    /Every affected/,
  );
  assert.deepEqual(f.store.works.assets.get('owner', current.indexedVersionRef)!.applicability, [use]);
});
