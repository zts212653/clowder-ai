/**
 * C06 / O2 — the L0 compile child renders the member snapshot frozen at
 * admission instead of re-reading the catalog when it runs. Uses the real CLI
 * child (not a fake spawn): a snapshot carrying a canary role renders that
 * canary even though the on-disk catalog never contained it, and an
 * unsupported snapshot fails closed instead of falling back to disk.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { clearL0Cache, compileL0ViaSubprocess } = await import(
  '../dist/domains/cats/services/agents/providers/l0-compiler.js'
);
const { freezeL0Input, frozenL0InputDigest } = await import(
  '../dist/domains/cats/services/agents/providers/l0-frozen-input.js'
);

const REPO_ROOT = resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CAT = 'codex';
const leftoverInputs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('cat-cafe-l0-input-'));

afterEach(() => clearL0Cache());

describe('frozen L0 input (C06)', () => {
  it('the child renders the admitted snapshot, not the live catalog, and cleans up its input file', async () => {
    assert.ok(catRegistry.tryGet(CAT), 'fixture member is registered');
    const before = new Set(leftoverInputs());
    const live = await compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT });
    assert.doesNotMatch(live, /frozen-role-canary/);

    const snapshot = freezeL0Input();
    const frozen = {
      ...snapshot,
      configs: {
        ...snapshot.configs,
        [CAT]: { ...snapshot.configs[CAT], roleDescription: 'frozen-role-canary', configuredIdentity: ['role'] },
      },
    };
    const rendered = await compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT, frozenInput: frozen });
    assert.match(rendered, /角色：frozen-role-canary/);
    assert.deepEqual(
      leftoverInputs().filter((name) => !before.has(name)),
      [],
      'the private snapshot file is removed after the compile',
    );
  });

  it('a different snapshot is a different cache entry; the same snapshot reuses it', async () => {
    const snapshot = freezeL0Input();
    const changed = {
      ...snapshot,
      configs: {
        ...snapshot.configs,
        [CAT]: { ...snapshot.configs[CAT], personality: 'digest-canary', configuredIdentity: ['role'] },
      },
    };
    assert.notEqual(frozenL0InputDigest(snapshot), frozenL0InputDigest(changed));
    assert.equal(frozenL0InputDigest(snapshot), frozenL0InputDigest(structuredClone(snapshot)));
    let spawns = 0;
    const realSpawn = (await import('node:child_process')).spawn;
    const spawnFn = (...args) => {
      spawns++;
      return realSpawn(...args);
    };
    await compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT, frozenInput: snapshot, spawnFn });
    await compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT, frozenInput: snapshot, spawnFn });
    assert.equal(spawns, 1, 'unchanged identity inputs do not recompile');
    const changedOut = await compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT, frozenInput: changed, spawnFn });
    assert.equal(spawns, 2);
    assert.match(changedOut, /digest-canary/);
  });

  it('an unsupported snapshot fails before send instead of reading the live catalog', async () => {
    await assert.rejects(
      compileL0ViaSubprocess({ catId: CAT, cwd: REPO_ROOT, frozenInput: { ...freezeL0Input(), version: 99 } }),
      /not a supported snapshot/,
    );
  });
});
