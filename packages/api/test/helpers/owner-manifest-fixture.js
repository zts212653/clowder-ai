import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectContentOwnerService } from '../../dist/domains/video-studio/content-owner/service.js';
import { ProjectContentOwnerStore } from '../../dist/domains/video-studio/content-owner/store.js';

export const collect = async (iterator) => {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
};

export async function ownerManifestFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'task229-manifest-window-'));
  const manifestRoot = join(root, 'projects', 'content-owner-v1');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new ProjectContentOwnerService({ dataDir: root });
  const store = new ProjectContentOwnerStore(root);
  const refs = [];
  const source = { sourceRef: 'message:fixture:saved', artifactRef: '/uploads/fixture.png', revision: 'exact-fixture' };
  for (let i = 0; i < 9; i++) {
    const contentRef = `prepared-media:fixture-${i}`;
    refs.push(contentRef);
    await service.importContent({
      contentRef,
      bytes: Buffer.from(String(i)),
      mediaType: 'image/png',
      operationId: `import-${i}`,
      actor: { kind: 'human', actorId: 'owner' },
      publicationScope: { ownerUserId: 'owner', threadId: 'fixture', taskId: 'fixture' },
      sourcePublication: source,
    });
  }
  const lookup = { lookupId: 'all', ownerUserId: 'owner', ...source, revisions: [source.revision] };
  const statePath = (ref) => join(manifestRoot, createHash('sha256').update(ref).digest('hex'), 'state.json');
  return { root, manifestRoot, service, store, refs, statePath, lookup };
}

/** Count only canonical fixture reads. Restore both the CJS object and ESM binding. */
export function interceptManifestReads(t, fixture, read) {
  const original = fs.readFile;
  let active = 0;
  let peak = 0;
  const paths = [];
  fs.readFile = async (path, ...args) => {
    if (!String(path).startsWith(`${fixture.manifestRoot}/`) || !String(path).endsWith('/state.json')) {
      return original(path, ...args);
    }
    paths.push(String(path));
    active++;
    peak = Math.max(peak, active);
    try {
      return await read({ path, args, index: paths.length, original });
    } finally {
      active--;
    }
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = original;
    syncBuiltinESMExports();
    assert.equal(active, 0, 'no fixture reads escape their consumer');
  });
  return { stats: () => ({ active, peak, paths: [...paths] }) };
}
