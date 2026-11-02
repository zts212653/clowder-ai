import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CharacterAssetBinding } from '@cat-cafe/shared';
import { canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

for (const damage of ['missing', 'changed'] as const) {
  for (const disposition of ['unbound', 'clear', 'restore-a', 'unavailable-c'] as const) {
    test(`revoke with ${damage} successor: ${disposition}`, async (t) => {
      const f = await canonFixture();
      t.after(f.cleanup);
      const use = {
        subjectRef: { kind: 'member' as const, catId: 'director' },
        representation: 'cat',
        styleKey: 'series',
        role: 'avatar' as const,
      };
      const a = await f.mark(await f.image('a.png', 'a', [use]));
      const b = await f.mark(await f.image('b.png', 'b', [use]));
      const c = await f.mark(await f.image('c.png', 'c', [use]));
      await f.replace(a, b);
      const from = f.store.works.assets.get('owner', a.indexedVersionRef)!;
      const to = f.store.works.assets.get('owner', b.indexedVersionRef)!;
      let binding: CharacterAssetBinding | undefined;
      if (disposition !== 'unbound') {
        const receipt = (await f.service.run(
          {
            action: 'bind-character-asset',
            mode: 'set',
            slot: { catId: 'director', role: 'member-avatar' },
            indexedVersionRef: to.indexedVersionRef,
            expectedAssetRevision: to.revision,
            expectedBindingRevision: 0,
            operationId: 'select-b',
            evidenceRefs: ['human:source'],
            reason: '原先明确选择 B',
          },
          canonHuman,
        )) as { bindings: CharacterAssetBinding[] };
        binding = receipt.bindings[0];
        assert.ok(binding);
      }
      const command = {
        action: 'supersede-asset',
        mode: 'revoke',
        fromVersionRef: from.indexedVersionRef,
        toVersionRef: to.indexedVersionRef,
        expectedFromRevision: from.revision,
        expectedToRevision: to.revision,
        eventRef: from.supersededBy!.eventRef,
        operationId: 'revoke-a-b',
        reason: '撤销原取代，独立处置当前头像',
        bindings: binding
          ? [
              {
                bindingRef: binding.bindingRef,
                expectedBindingRevision: binding.bindingRevision,
                indexedVersionRef:
                  disposition === 'restore-a'
                    ? from.indexedVersionRef
                    : disposition === 'unavailable-c'
                      ? c.indexedVersionRef
                      : null,
                expectedAssetRevision: disposition === 'restore-a' ? from.revision : c.revision,
                reason: '明确处置此用途',
              },
            ]
          : [],
      };
      const damageSource = async (name: string) => {
        if (damage === 'missing') await unlink(join(f.root, name));
        else await writeFile(join(f.root, name), 'changed bytes');
      };
      await damageSource('b.png');
      if (disposition === 'unavailable-c') {
        await damageSource('c.png');
        const history = f.store.works.assets.history('owner', a.indexedVersionRef);
        await assert.rejects(f.service.run(command, canonHuman), /verified available source/);
        assert.deepEqual(f.store.works.assets.get('owner', a.indexedVersionRef), from);
        assert.deepEqual(f.store.works.assets.get('owner', b.indexedVersionRef), to);
        assert.deepEqual(f.store.works.assets.binding('owner', binding!.bindingRef), binding);
        assert.deepEqual(f.store.works.assets.history('owner', a.indexedVersionRef), history);
        command.bindings = command.bindings.map((choice) => ({ ...choice, indexedVersionRef: null }));
      }
      const receipt = await f.service.run(command, canonHuman);
      assert.equal(f.store.works.assets.get('owner', a.indexedVersionRef)!.supersededBy, null);
      if (binding)
        assert.equal(
          f.store.works.assets.binding('owner', binding.bindingRef)?.indexedVersionRef,
          disposition === 'restore-a' ? from.indexedVersionRef : null,
        );
      assert.deepEqual(await f.service.run(command, canonHuman), receipt);
    });
  }
}
