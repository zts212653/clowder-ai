import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CharacterAssetBinding } from '@cat-cafe/shared';
import { canonFixture, canonHuman } from './helpers/asset-canon-fixture.js';

for (const action of ['direct-binding', 'failed', 'experimental', 'supersede'] as const) {
  for (const damage of ['missing', 'changed'] as const) {
    test(`${action} rejects a ${damage} binding target atomically and can retry after source recovery`, async (t) => {
      const f = await canonFixture();
      t.after(f.cleanup);
      const use = {
        subjectRef: { kind: 'member' as const, catId: 'director' },
        representation: 'cat',
        styleKey: 'series',
        role: 'portrait' as const,
      };
      const a = await f.mark(await f.image('a.png', 'a', [use]));
      const b = await f.mark(await f.image('b.png', 'b', [use]));
      const c = await f.mark(await f.image('c.png', 'c', [use]));
      const bind = {
        action: 'bind-character-asset',
        mode: 'set',
        slot: use,
        indexedVersionRef: a.indexedVersionRef,
        expectedAssetRevision: a.revision,
        expectedBindingRevision: 0,
        evidenceRefs: ['human:original'],
        reason: '保留原始用途',
        operationId: 'initial-binding',
      };
      const binding = ((await f.service.run(bind, canonHuman)) as { bindings: CharacterAssetBinding[] }).bindings[0];
      assert.ok(binding);
      const dispositions = [
        {
          bindingRef: binding.bindingRef,
          expectedBindingRevision: binding.bindingRevision,
          indexedVersionRef: c.indexedVersionRef,
          expectedAssetRevision: c.revision,
          reason: '为这个用途单独选另一张',
        },
      ];
      const command =
        action === 'direct-binding'
          ? {
              ...bind,
              operationId: 'change-binding',
              indexedVersionRef: c.indexedVersionRef,
              expectedAssetRevision: c.revision,
              expectedBindingRevision: binding.bindingRevision,
            }
          : action === 'supersede'
            ? {
                action: 'supersede-asset',
                mode: 'replace',
                fromVersionRef: a.indexedVersionRef,
                toVersionRef: b.indexedVersionRef,
                expectedFromRevision: a.revision,
                expectedToRevision: b.revision,
                bindings: dispositions,
                reason: '全局用 B 取代 A，这个用途改用 C',
                operationId: 'replace-with-alternate-binding',
              }
            : {
                action: 'set-asset-status',
                indexedVersionRef: a.indexedVersionRef,
                expectedRevision: a.revision,
                status: action,
                bindings: dispositions,
                reason: '纠正原素材，保留独立用途的可用来源',
                operationId: 'demote-with-binding',
              };
      const history = f.store.works.assets.history('owner', a.indexedVersionRef);
      if (damage === 'missing') await unlink(join(f.root, 'c.png'));
      else await writeFile(join(f.root, 'c.png'), 'changed bytes');

      await assert.rejects(f.service.run(command, canonHuman), /verified available source/);
      assert.deepEqual(f.store.works.assets.get('owner', a.indexedVersionRef), a);
      assert.deepEqual(f.store.works.assets.get('owner', b.indexedVersionRef), b);
      assert.deepEqual(f.store.works.assets.binding('owner', binding.bindingRef), binding);
      assert.deepEqual(f.store.works.assets.history('owner', a.indexedVersionRef), history);

      await writeFile(join(f.root, 'c.png'), 'c');
      await f.service.run(command, canonHuman);
      assert.equal(f.store.works.assets.binding('owner', binding.bindingRef)?.indexedVersionRef, c.indexedVersionRef);
    });
  }
}
