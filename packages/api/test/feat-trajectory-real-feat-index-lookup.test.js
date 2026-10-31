/**
 * F233 Phase C C2b step 2 part 3 — RealFeatIndexLookup tests
 *
 * Stub fs adapter returns canned feat doc contents; verify branch → featId
 * extraction, cache behavior, missing dir graceful degradation.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('RealFeatIndexLookup', () => {
  describe('findByBranch — extract from feat doc Timeline branch references', () => {
    test('finds featId from F188 doc mentioning fix/f188-phase-k branch', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F188-cat-config.md'];
        },
        async readFile() {
          return [
            '# F188: Cat Config',
            '',
            '## Timeline',
            '',
            '| 2026-06-09 | Phase K branch pushed: `fix/f188-phase-k-config-health-surface` |',
            '| 2026-06-19 | F188 提包球 case discovered (no PR for fix/f188-phase-k-config-health-surface) |',
          ].join('\n');
        },
      };
      const lookup = new RealFeatIndexLookup('/fake/docs/features', stub);
      const featIds = await lookup.findByBranch('fix/f188-phase-k-config-health-surface');
      assert.deepStrictEqual(featIds, ['F188']);
    });

    test('finds multiple featIds when same branch appears in multiple feat docs', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F188-cat-config.md', 'F233-ball-custody.md'];
        },
        async readFile(path) {
          if (path.endsWith('F188-cat-config.md')) {
            return 'See fix/f188-shared work';
          }
          if (path.endsWith('F233-ball-custody.md')) {
            return 'Also references fix/f188-shared in Phase C Timeline';
          }
          return '';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake/docs/features', stub);
      const featIds = await lookup.findByBranch('fix/f188-shared');
      assert.strictEqual(featIds.length, 2);
      assert.ok(featIds.includes('F188'));
      assert.ok(featIds.includes('F233'));
    });

    test('branch not in any feat doc → empty array', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F188-x.md'];
        },
        async readFile() {
          return 'No branches mentioned';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake/dir', stub);
      const featIds = await lookup.findByBranch('fix/unknown');
      assert.deepStrictEqual(featIds, []);
    });

    test('empty branchName → empty array (no scan)', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      let called = false;
      const stub = {
        async listFeatDocs() {
          called = true;
          return [];
        },
        async readFile() {
          return '';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake/dir', stub);
      const featIds = await lookup.findByBranch('');
      assert.deepStrictEqual(featIds, []);
      assert.strictEqual(called, false, 'empty branchName short-circuits');
    });

    test('directory does not exist → empty cache, graceful degrade', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          throw new Error('ENOENT: no such file or directory');
        },
        async readFile() {
          return '';
        },
      };
      const lookup = new RealFeatIndexLookup('/nonexistent', stub);
      const featIds = await lookup.findByBranch('fix/f188-x');
      assert.deepStrictEqual(featIds, [], 'graceful degrade — heuristic still works');
    });

    test('single file read failure does not poison the whole cache', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F100-broken.md', 'F200-ok.md'];
        },
        async readFile(path) {
          if (path.endsWith('F100-broken.md')) throw new Error('EACCES');
          return 'fix/f200-x mentioned';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      const featIds = await lookup.findByBranch('fix/f200-x');
      assert.deepStrictEqual(featIds, ['F200'], 'F100 read failure does not block F200');
    });

    test('skips non-feat-doc filenames', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['README.md', 'TEMPLATE.md', 'F188-real.md'];
        },
        async readFile(path) {
          if (path.endsWith('F188-real.md')) return 'fix/f188-x';
          return 'fix/f188-x in non-feat file';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      const featIds = await lookup.findByBranch('fix/f188-x');
      assert.deepStrictEqual(featIds, ['F188'], 'only F### filenames contribute');
    });

    test('cloud round 3 P2: backtick-quoted F-less branches captured (e.g. `fix/redis-cleanup`)', async () => {
      // F-less branches mentioned in feat docs were previously SKIPPED because
      // the regex required `[Ff]\\d{2,4}` in the branch path — defeating
      // feat_index's design intent (catch branches heuristic join misses).
      // Backtick convention indicates branch reference, no F### required.
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F188-cat-config.md'];
        },
        async readFile() {
          return [
            '# F188',
            '',
            'Implemented in `fix/redis-cleanup` (no F-token in branch name).',
            'Also see `chore/cleanup-stale` and `feat/general-improvement`.',
            'Plus an inline mention of `fix/F188-with-token` for completeness.',
          ].join('\n');
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      // F-less branches in backticks are now indexed (cloud round 3 P2 fix)
      assert.deepStrictEqual(await lookup.findByBranch('fix/redis-cleanup'), ['F188']);
      assert.deepStrictEqual(await lookup.findByBranch('chore/cleanup-stale'), ['F188']);
      assert.deepStrictEqual(await lookup.findByBranch('feat/general-improvement'), ['F188']);
      // Backward compat: F### branches still indexed
      assert.deepStrictEqual(await lookup.findByBranch('fix/F188-with-token'), ['F188']);
    });

    test('cloud round 3 P2: F-less branches in prose (no backticks) NOT indexed (precision guard)', async () => {
      // Without backticks, F-less branches still NOT matched — precision guard
      // prevents false positives like "use feat/care" being read as a branch.
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const stub = {
        async listFeatDocs() {
          return ['F188-cat-config.md'];
        },
        async readFile() {
          // No backticks, no F### in the F-less branch reference
          return 'See fix/redis-cleanup in the codebase for details.';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      assert.deepStrictEqual(
        await lookup.findByBranch('fix/redis-cleanup'),
        [],
        'F-less prose mention should NOT match without backticks (precision guard)',
      );
    });

    test('extracts hotfix / chore / docs / refactor / test / style branch prefixes', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      const content = [
        'hotfix/F123-urgent',
        'chore/f456-cleanup',
        'docs/f789-update',
        'refactor/F234-split',
        'test/f567-coverage',
        'style/F890-format',
      ].join(' ');
      const stub = {
        async listFeatDocs() {
          return ['F999-multi.md'];
        },
        async readFile() {
          return content;
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      // F999 doc references all 6 branches → each branch maps to F999
      const branches = ['hotfix/F123-urgent', 'chore/f456-cleanup', 'docs/f789-update'];
      for (const b of branches) {
        const featIds = await lookup.findByBranch(b);
        assert.deepStrictEqual(featIds, ['F999'], `${b} → F999`);
      }
    });
  });

  describe('cache behavior', () => {
    test('caches across calls — listFeatDocs only called once', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      let listCalls = 0;
      const stub = {
        async listFeatDocs() {
          listCalls += 1;
          return ['F188-x.md'];
        },
        async readFile() {
          return 'fix/f188-x';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      await lookup.findByBranch('fix/f188-x');
      await lookup.findByBranch('fix/f188-x');
      await lookup.findByBranch('fix/something-else');
      assert.strictEqual(listCalls, 1, 'cache prevents repeated scans');
    });

    test('invalidateCache forces re-scan', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      let listCalls = 0;
      const stub = {
        async listFeatDocs() {
          listCalls += 1;
          return ['F188-x.md'];
        },
        async readFile() {
          return 'fix/f188-x';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      await lookup.findByBranch('fix/f188-x');
      lookup.invalidateCache();
      await lookup.findByBranch('fix/f188-x');
      assert.strictEqual(listCalls, 2, 'invalidate triggers re-scan');
    });

    test('concurrent calls coalesce to single scan (not N parallel scans)', async () => {
      const { RealFeatIndexLookup } = await import('../dist/domains/feat-trajectory/RealFeatIndexLookup.js');
      let listCalls = 0;
      const stub = {
        async listFeatDocs() {
          listCalls += 1;
          // Simulate slow IO so concurrent calls overlap
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ['F188-x.md'];
        },
        async readFile() {
          return 'fix/f188-x';
        },
      };
      const lookup = new RealFeatIndexLookup('/fake', stub);
      // Fire 5 concurrent calls before any settles
      const results = await Promise.all([
        lookup.findByBranch('fix/f188-x'),
        lookup.findByBranch('fix/f188-x'),
        lookup.findByBranch('fix/f188-x'),
        lookup.findByBranch('fix/f188-x'),
        lookup.findByBranch('fix/f188-x'),
      ]);
      assert.strictEqual(listCalls, 1, 'buildPromise coalesces concurrent calls');
      for (const r of results) assert.deepStrictEqual(r, ['F188']);
    });
  });
});
