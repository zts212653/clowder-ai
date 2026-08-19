import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createEvalReleaseTruthResolver,
  EvalReleaseTruthError,
} from '../../dist/infrastructure/harness-eval/eval-release-truth-resolver.js';

const sha = (letter) => letter.repeat(40);

function fakeGit({ refs, ancestors }) {
  return {
    resolveCommit(rev) {
      const resolved = refs.get(rev);
      if (!resolved) throw new Error(`unknown revision ${rev}`);
      return resolved;
    },
    isAncestor(ancestor, descendant) {
      return ancestors.has(`${ancestor}:${descendant}`);
    },
  };
}

describe('F266 release truth resolver', () => {
  it('keeps packaged startup alive while unavailable Git truth remains fail-closed', () => {
    const packagedRoot = mkdtempSync(join(tmpdir(), 'clowder-packaged-runtime-'));
    try {
      const resolver = createEvalReleaseTruthResolver({ repoRoot: packagedRoot });

      assert.equal(resolver.loadedRuntimeHead, undefined);
      assert.throws(
        () => resolver.verifyMainLanded(sha('a')),
        (error) => error instanceof EvalReleaseTruthError && error.code === 'commit_unavailable',
      );
      assert.throws(
        () => resolver.verifyLiveActive(sha('a')),
        (error) => error instanceof EvalReleaseTruthError && error.code === 'commit_unavailable',
      );
      assert.throws(
        () => resolver.verifyLiveActive('--all'),
        (error) => error instanceof EvalReleaseTruthError && error.code === 'invalid_commit',
      );
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true });
    }
  });

  it('keeps main_landed and live_active as separate server-owned facts', () => {
    const landed = sha('a');
    const mainHead = sha('b');
    const runtimeHead = sha('c');
    const resolver = createEvalReleaseTruthResolver({
      git: fakeGit({
        refs: new Map([
          ['HEAD', runtimeHead],
          ['origin/main', mainHead],
          [landed, landed],
        ]),
        ancestors: new Set([`${landed}:${mainHead}`, `${landed}:${runtimeHead}`]),
      }),
    });

    assert.deepEqual(resolver.verifyMainLanded(landed), {
      commitSha: landed,
      evidenceRef: `git:origin/main@${mainHead}:contains:${landed}`,
    });
    assert.deepEqual(resolver.verifyLiveActive(landed), {
      commitSha: landed,
      evidenceRef: `runtime:${runtimeHead}:contains:${landed}`,
    });
  });

  it('rejects malformed, unknown, main-only, and live-only claims independently', () => {
    const mainOnly = sha('a');
    const liveOnly = sha('d');
    const mainHead = sha('b');
    const runtimeHead = sha('c');
    const resolver = createEvalReleaseTruthResolver({
      git: fakeGit({
        refs: new Map([
          ['HEAD', runtimeHead],
          ['origin/main', mainHead],
          [mainOnly, mainOnly],
          [liveOnly, liveOnly],
        ]),
        ancestors: new Set([`${mainOnly}:${mainHead}`, `${liveOnly}:${runtimeHead}`]),
      }),
    });

    assert.throws(() => resolver.verifyMainLanded('--all'), EvalReleaseTruthError);
    assert.throws(() => resolver.verifyMainLanded(sha('f')), /cannot resolve/);
    assert.throws(() => resolver.verifyLiveActive(mainOnly), /not active in loaded runtime/);
    assert.throws(() => resolver.verifyMainLanded(liveOnly), /not landed on origin\/main/);
  });

  it('freezes the loaded runtime head when the resolver is created', () => {
    const landed = sha('a');
    const originalRuntimeHead = sha('b');
    const laterCheckoutHead = sha('c');
    const refs = new Map([
      ['HEAD', originalRuntimeHead],
      ['origin/main', laterCheckoutHead],
      [landed, landed],
    ]);
    const ancestors = new Set([`${landed}:${originalRuntimeHead}`]);
    const resolver = createEvalReleaseTruthResolver({ git: fakeGit({ refs, ancestors }) });

    refs.set('HEAD', laterCheckoutHead);
    ancestors.delete(`${landed}:${originalRuntimeHead}`);
    ancestors.add(`${landed}:${laterCheckoutHead}`);

    assert.throws(() => resolver.verifyLiveActive(landed), /not active in loaded runtime/);
  });
});
