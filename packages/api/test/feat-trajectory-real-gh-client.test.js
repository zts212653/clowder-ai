/**
 * F233 Phase C C2b step 2 part 2 — RealGhClient tests
 *
 * Stub `ghCmd` to return canned `gh pr list --json` output; verify PR shape,
 * timestamp parsing, mergedToMain logic without spawning real gh CLI.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('RealGhClient', () => {
  describe('findPrByBranch — happy paths', () => {
    test('open PR → prOpenedAt parsed, prMergedAt null, mergedToMain false', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 2439,
          state: 'OPEN',
          createdAt: '2026-06-19T18:00:00Z',
          mergedAt: null,
          headRefName: 'feat/f233-phase-c-c2a',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('zts212653/cat-cafe', stub);
      const pr = await client.findPrByBranch('feat/f233-phase-c-c2a');
      assert.strictEqual(pr.prNumber, 2439);
      assert.strictEqual(pr.prState, 'open', 'state normalized to lowercase');
      assert.strictEqual(pr.prOpenedAt, Date.parse('2026-06-19T18:00:00Z'));
      assert.strictEqual(pr.prMergedAt, null);
      assert.strictEqual(pr.mergedToMain, false, 'open != merged');
    });

    test('merged PR to main → mergedToMain=true, prMergedAt non-null', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 2439,
          state: 'MERGED',
          createdAt: '2026-06-19T18:00:00Z',
          mergedAt: '2026-06-20T03:54:49Z',
          headRefName: 'feat/f233-phase-c-c2a',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('zts212653/cat-cafe', stub);
      const pr = await client.findPrByBranch('feat/f233-phase-c-c2a');
      assert.strictEqual(pr.prState, 'merged');
      assert.strictEqual(pr.prMergedAt, Date.parse('2026-06-20T03:54:49Z'));
      assert.strictEqual(pr.mergedToMain, true, 'merged + base=main → mergedToMain=true');
    });

    test('closed PR (never merged) → prMergedAt=null, mergedToMain=false', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 2200,
          state: 'CLOSED',
          createdAt: '2026-05-01T10:00:00Z',
          mergedAt: null,
          headRefName: 'feat/abandoned',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('zts212653/cat-cafe', stub);
      const pr = await client.findPrByBranch('feat/abandoned');
      assert.strictEqual(pr.prState, 'closed');
      assert.strictEqual(pr.prMergedAt, null);
      assert.strictEqual(pr.mergedToMain, false);
    });

    test('merged PR to non-main base → mergedToMain=false', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 2500,
          state: 'MERGED',
          createdAt: '2026-06-15T08:00:00Z',
          mergedAt: '2026-06-15T18:00:00Z',
          headRefName: 'feat/sub-feature',
          baseRefName: 'feat/parent-feature', // merged to parent feature branch
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('zts212653/cat-cafe', stub);
      const pr = await client.findPrByBranch('feat/sub-feature');
      assert.strictEqual(pr.prState, 'merged');
      assert.strictEqual(pr.mergedToMain, false, 'merged but base != main → mergedToMain=false');
    });

    test('master as alternate main name → mergedToMain=true', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 100,
          state: 'MERGED',
          createdAt: '2026-01-01T00:00:00Z',
          mergedAt: '2026-01-01T00:00:00Z',
          headRefName: 'old-style',
          baseRefName: 'master',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub);
      const pr = await client.findPrByBranch('old-style');
      assert.strictEqual(pr.mergedToMain, true, 'master also counts as main');
    });

    test('custom mainBranchNames set → only configured branches count', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 100,
          state: 'MERGED',
          createdAt: '2026-01-01T00:00:00Z',
          mergedAt: '2026-01-01T00:00:00Z',
          headRefName: 'feature/x',
          baseRefName: 'production', // custom main
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub, new Set(['production']));
      const pr = await client.findPrByBranch('feature/x');
      assert.strictEqual(pr.mergedToMain, true, 'custom mainBranchNames set respected');
    });
  });

  describe('findPrByBranch — null paths (no PR)', () => {
    test('empty array → null (branch never had a PR)', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => '[]';
      const client = new RealGhClient('test/repo', stub);
      const pr = await client.findPrByBranch('feat/never-opened-pr');
      assert.strictEqual(pr, null);
    });

    test('empty stdout → null', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => '   \n  ';
      const client = new RealGhClient('test/repo', stub);
      const pr = await client.findPrByBranch('feat/x');
      assert.strictEqual(pr, null);
    });

    test('empty branchName → null without calling gh', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      let called = false;
      const stub = async () => {
        called = true;
        return '[]';
      };
      const client = new RealGhClient('test/repo', stub);
      const pr = await client.findPrByBranch('');
      assert.strictEqual(pr, null);
      assert.strictEqual(called, false, 'short-circuit empty branchName');
    });
  });

  describe('findPrByBranch — error paths', () => {
    test('non-JSON stdout → throws', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => 'oops not json';
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(() => client.findPrByBranch('feat/x'), /non-JSON stdout/);
    });

    test('unexpected state value → throws (防 gh API 改 schema 静默吞)', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 1,
          state: 'WEIRD_NEW_STATE',
          createdAt: '2026-01-01T00:00:00Z',
          mergedAt: null,
          headRefName: 'x',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(() => client.findPrByBranch('x'), /unexpected PR state/);
    });

    test('invalid createdAt timestamp → throws', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 1,
          state: 'OPEN',
          createdAt: 'not-a-date',
          mergedAt: null,
          headRefName: 'x',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(() => client.findPrByBranch('x'), /invalid createdAt/);
    });

    test('missing PR number → throws', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          // number missing
          state: 'OPEN',
          createdAt: '2026-01-01T00:00:00Z',
          mergedAt: null,
          headRefName: 'x',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(() => client.findPrByBranch('x'), /missing 'number'/);
    });

    test('invalid mergedAt timestamp → throws', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stubOutput = JSON.stringify([
        {
          number: 1,
          state: 'MERGED',
          createdAt: '2026-01-01T00:00:00Z',
          mergedAt: 'not-a-date',
          headRefName: 'x',
          baseRefName: 'main',
        },
      ]);
      const stub = async () => stubOutput;
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(() => client.findPrByBranch('x'), /invalid mergedAt/);
    });

    test('cloud round 2 P1: gh subprocess error (missing binary / auth expired) → null + warn log, no throw', async () => {
      // PR metadata is OPTIONAL for git-only trajectory events. A failing gh
      // subprocess should NOT cascade up GitRefSnapshotCollector and drop the
      // entire branch snapshot. Verify graceful degrade to null + warn.
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => {
        throw new Error('gh pr list ... exited 4: not authenticated');
      };
      const warnings = [];
      const logger = { warn: (obj, msg) => warnings.push({ obj, msg }) };
      const client = new RealGhClient('test/repo', stub, undefined, logger);
      const pr = await client.findPrByBranch('feat/F215-malformed-toolcall-recovery');
      assert.strictEqual(pr, null, 'subprocess error → null, NOT throw');
      assert.strictEqual(warnings.length, 1, 'should warn-log the gh failure');
      assert.match(warnings[0].msg, /gh PR lookup failed/);
      assert.strictEqual(warnings[0].obj.branchName, 'feat/F215-malformed-toolcall-recovery');
      assert.strictEqual(warnings[0].obj.repoFullName, 'test/repo');
    });

    test('cloud round 2 P1: subprocess error without logger → still returns null silently (no throw)', async () => {
      // Logger is optional. Without it, no warn — but still don't throw.
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => {
        throw new Error('gh: command not found');
      };
      const client = new RealGhClient('test/repo', stub);
      const pr = await client.findPrByBranch('feat/x');
      assert.strictEqual(pr, null);
    });

    test('cloud round 2 P1: invalid JSON still throws (validation errors are fail-loud)', async () => {
      // Sanity: distinguish "gh ran but produced garbage" (contract violation,
      // throw) from "gh failed to run" (env issue, degrade). Same as the
      // existing `non-JSON stdout → throws` test but explicit cloud-round-2
      // regression to lock in the contract distinction.
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      const stub = async () => 'not-json-but-gh-ran';
      const client = new RealGhClient('test/repo', stub);
      await assert.rejects(
        () => client.findPrByBranch('x'),
        /non-JSON stdout/,
        'gh ran but output garbage → throw (not graceful degrade)',
      );
    });
  });

  describe('findPrByBranch — args passed to gh', () => {
    test('passes correct gh pr list args incl. --repo + --head + --state all + --json fields', async () => {
      const { RealGhClient } = await import('../dist/domains/feat-trajectory/RealGhClient.js');
      let capturedArgs = null;
      const stub = async (args) => {
        capturedArgs = args;
        return '[]';
      };
      const client = new RealGhClient('zts212653/cat-cafe', stub);
      await client.findPrByBranch('feat/check-args');
      assert.deepStrictEqual(capturedArgs, [
        'pr',
        'list',
        '--repo',
        'zts212653/cat-cafe',
        '--head',
        'feat/check-args',
        '--state',
        'all',
        '--json',
        'number,state,createdAt,mergedAt,headRefName,baseRefName',
        '--limit',
        '1',
      ]);
    });
  });
});
