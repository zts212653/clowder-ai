/**
 * F233 Phase C C2b step 2 part 4 — RealThreadSearch tests
 *
 * Stub thread search adapter returns canned thread list; verify featId matching
 * by label / title + graceful degrade + sanity checks.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('RealThreadSearch', () => {
  describe('findByFeatId — happy paths', () => {
    test('cloud round 5 P2: contract requires label NAMES not IDs (resolved by runtime adapter)', async () => {
      // Lock in the contract: RealThreadSearch matches text patterns
      // ("feat:F###", "F###") against the `labels` field. The runtime adapter
      // in index.ts is responsible for resolving Thread.labels (which stores
      // LabelStore IDs per ILabelStore.updateLabels(labelIds: string[])) →
      // ThreadLabel.name strings BEFORE handing them to this class. This test
      // asserts text-matching behavior on the post-resolution shape — raw IDs
      // (UUID-like, no `feat:F###` pattern) MUST NOT match.
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            // Adapter resolved label ID → name "feat:F188": MATCHES
            { threadId: 'thr-1', title: 'plain', labels: ['feat:F188'], lastMessageAt: 1, lastActivityAt: 1 },
            // Raw label ID (UUID-like) with no resolution: does NOT match — proves
            // the adapter's resolution job is required, not bypassable.
            { threadId: 'thr-2', title: 'plain', labels: ['01HXYZABC123DEF'], lastMessageAt: 1, lastActivityAt: 1 },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1, 'name-resolved label matches; raw ID does not');
      assert.strictEqual(matches[0].threadId, 'thr-1');
    });

    test('matches thread by exact feat:F### label', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            {
              threadId: 'thr-1',
              title: 'Some random title',
              lastMessageAt: 1_700_000_000_000,
              lastActivityAt: 1_700_000_000_000,
              labels: ['feat:F188'],
            },
            {
              threadId: 'thr-2',
              title: 'Unrelated',
              lastMessageAt: 1_700_000_000_000,
              lastActivityAt: 1_700_000_000_000,
              labels: ['other:tag'],
            },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].threadId, 'thr-1');
      assert.strictEqual(matches[0].lastMessageAt, 1_700_000_000_000);
      assert.strictEqual(matches[0].lastActivityAt, 1_700_000_000_000);
    });

    test('matches thread by F### token in title (case-insensitive)', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            { threadId: 'thr-1', title: 'F233 Phase C 收口', lastMessageAt: 100, lastActivityAt: 200 },
            { threadId: 'thr-2', title: 'unrelated work', lastMessageAt: 50, lastActivityAt: 75 },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('f233');
      assert.strictEqual(matches.length, 1, 'case-insensitive F233 match');
      assert.strictEqual(matches[0].threadId, 'thr-1');
    });

    test('matches by F### in labels (other than feat: prefix)', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            { threadId: 'thr-1', title: 'untitled', labels: ['F188-discuss'], lastMessageAt: 1, lastActivityAt: 2 },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1);
    });

    test('multiple matching threads return all', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            { threadId: 'thr-1', title: 'F188 init', labels: [], lastMessageAt: 100, lastActivityAt: 100 },
            { threadId: 'thr-2', title: 'F188 phase k', labels: [], lastMessageAt: 200, lastActivityAt: 250 },
            { threadId: 'thr-3', title: 'unrelated', labels: [], lastMessageAt: 50, lastActivityAt: 50 },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 2);
      const ids = matches.map((m) => m.threadId).sort();
      assert.deepStrictEqual(ids, ['thr-1', 'thr-2']);
    });

    test('no matches → empty array', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [{ threadId: 'thr-1', title: 'unrelated', labels: [], lastMessageAt: 1, lastActivityAt: 1 }];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F999');
      assert.deepStrictEqual(matches, []);
    });

    test('null lastMessageAt / lastActivityAt passes through', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [{ threadId: 'thr-1', title: 'F188 work', labels: [], lastMessageAt: null, lastActivityAt: null }];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].lastMessageAt, null);
      assert.strictEqual(matches[0].lastActivityAt, null);
    });

    test('word boundary: F23 does NOT match F233 (avoid false positives)', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [{ threadId: 'thr-1', title: 'About F233 work', labels: [], lastMessageAt: 1, lastActivityAt: 1 }];
        },
      };
      const search = new RealThreadSearch(stub);
      // Note: F23 (which is invalid per /^F\d{2,4}$/i sanity but lets be defensive)
      const matches = await search.findByFeatId('F23');
      // F23 passes sanity check (2 digits) BUT F23 should NOT match "F233" due to word boundary
      assert.strictEqual(matches.length, 0, 'F23 should not match F233 substring');
    });

    test('does not duplicate threads matched by both label and title', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            {
              threadId: 'thr-1',
              title: 'F188 phase k',
              labels: ['feat:F188', 'F188-extra'],
              lastMessageAt: 1,
              lastActivityAt: 1,
            },
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1, 'one thread → one result regardless of how many fields match');
    });
  });

  describe('sanity checks + graceful degrade', () => {
    test('empty featId → empty array (no adapter call)', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      let called = false;
      const stub = {
        async listAll() {
          called = true;
          return [];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('');
      assert.deepStrictEqual(matches, []);
      assert.strictEqual(called, false);
    });

    test('invalid featId format (not F###) → empty array, no adapter call', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      let called = false;
      const stub = {
        async listAll() {
          called = true;
          return [];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('badformat');
      assert.deepStrictEqual(matches, []);
      assert.strictEqual(called, false, 'reject early before adapter call');
    });

    test('adapter throws → graceful degrade returns empty array', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          throw new Error('thread store down');
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.deepStrictEqual(matches, [], 'graceful — heuristic still works without threads');
    });

    test('missing labels field defaults to empty (no crash)', async () => {
      const { RealThreadSearch } = await import('../dist/domains/feat-trajectory/RealThreadSearch.js');
      const stub = {
        async listAll() {
          return [
            { threadId: 'thr-1', title: 'F188 work', lastMessageAt: 1, lastActivityAt: 1 },
            // labels omitted entirely
          ];
        },
      };
      const search = new RealThreadSearch(stub);
      const matches = await search.findByFeatId('F188');
      assert.strictEqual(matches.length, 1, 'matches by title even without labels field');
    });
  });
});
