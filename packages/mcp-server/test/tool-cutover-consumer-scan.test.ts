import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXED_CUTOVER_CONSUMER_ROOTS } from '../src/tool-cutover.js';
import { scanRetiredNames } from '../src/tool-cutover-consumer-scan.js';
import { classifyCutoverReferences } from '../src/tool-cutover-negative-references.js';

async function fixtureFile(repoRoot: string, path: string, content: string): Promise<void> {
  const absolute = join(repoRoot, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

test('fixed-root scan keeps every literal visible while classifying only exact same-line negative evidence', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f286-cutover-scan-'));
  try {
    await fixtureFile(repoRoot, 'packages/api/src/stale.ts', "callTool('cat_cafe_old_alpha');\n");
    await fixtureFile(
      repoRoot,
      'packages/api/test/retirement.test.js',
      [
        "assert.equal(tools.has('cat_cafe_old_alpha'), false); // mcp-cutover-negative-reference: absence",
        "fake.route = 'cat_cafe_old_alpha'; // mcp-cutover-negative-reference: rejection",
        "assert.equal(names.includes('cat_cafe_old_beta'), false); // mcp-cutover-negative-reference: absence",
      ].join('\n'),
    );
    await fixtureFile(
      repoRoot,
      'packages/mcp-server/test/unmarked.test.js',
      "assert.equal(names.includes('cat_cafe_old_beta'), false);\n",
    );
    await fixtureFile(
      repoRoot,
      'packages/shared/test/unknown-marker.test.js',
      [
        "assert.equal(names.includes('cat_cafe_old_beta'), false); // mcp-cutover-negative-reference: unknown",
        "assert.equal(names.includes('cat_cafe_old_beta'), false); // mcp-cutover-negative-reference: absence because retired",
        "assert.equal(names.includes('cat_cafe_old_beta'), false); /// mcp-cutover-negative-reference: absence",
      ].join('\n'),
    );

    const scans = await scanRetiredNames(repoRoot, ['cat_cafe_old_beta', 'cat_cafe_old_alpha']);
    assert.deepEqual(
      scans.map((scan) => scan.retiredName),
      ['cat_cafe_old_alpha', 'cat_cafe_old_beta'],
    );
    assert.deepEqual(scans[0]?.scannedRoots, FIXED_CUTOVER_CONSUMER_ROOTS);
    assert.deepEqual(scans[0]?.negativeReferences, [
      {
        root: 'packages/api/test',
        path: 'packages/api/test/retirement.test.js',
        line: 1,
        kind: 'absence',
      },
      {
        root: 'packages/api/test',
        path: 'packages/api/test/retirement.test.js',
        line: 2,
        kind: 'rejection',
      },
    ]);
    assert.equal(scans[0]?.matches.length, 3, 'raw scan still exposes production and negative-test literals');
    assert.deepEqual(scans[1]?.negativeReferences, [
      {
        root: 'packages/api/test',
        path: 'packages/api/test/retirement.test.js',
        line: 3,
        kind: 'absence',
      },
    ]);
    assert.equal(scans[1]?.matches.length, 5, 'malformed and unknown-marker test references remain active matches');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('the seven F167 retirement assertions remain visible and pass only with manifest-bound evidence', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f286-cutover-f167-'));
  const fixtureConsumers = [
    'packages/api/test/turn-custody-event-wait-remedial-prompt.test.js',
    'packages/mcp-server/test/a2a-1577-terminal-retirement.test.mjs',
    'packages/api/test/a2a-1577-thread-context-seam.test.mjs',
    'packages/api/test/f317-live-dispatch-adoption.test.mjs',
  ];
  try {
    await fixtureFile(
      repoRoot,
      fixtureConsumers[0],
      "const COMPLETERS = ['cat_cafe_complete_event_wait', 'cat_cafe_complete_managed_hold', 'cat_cafe_complete_a2a_dispatch']; // mcp-cutover-negative-reference: absence\n", // mcp-cutover-negative-reference: absence
    );
    await fixtureFile(
      repoRoot,
      fixtureConsumers[1],
      "for (const name of ['cat_cafe_complete_managed_hold', 'cat_cafe_complete_a2a_dispatch']) {} // mcp-cutover-negative-reference: absence\n", // mcp-cutover-negative-reference: absence
    );
    await fixtureFile(
      repoRoot,
      fixtureConsumers[2],
      "return { tool: 'cat_cafe_complete_a2a_dispatch' }; // mcp-cutover-negative-reference: rejection\n", // mcp-cutover-negative-reference: rejection
    );
    await fixtureFile(
      repoRoot,
      fixtureConsumers[3],
      "assert.equal(tools.has('cat_cafe_complete_a2a_dispatch'), false); // mcp-cutover-negative-reference: absence\n", // mcp-cutover-negative-reference: absence
    );

    const scans = await scanRetiredNames(repoRoot, [
      'cat_cafe_complete_event_wait', // mcp-cutover-negative-reference: absence
      'cat_cafe_complete_managed_hold', // mcp-cutover-negative-reference: absence
      'cat_cafe_complete_a2a_dispatch', // mcp-cutover-negative-reference: absence
    ]);
    assert.deepEqual(
      Object.fromEntries(scans.map((scan) => [scan.retiredName, scan.matches.length])),
      {
        cat_cafe_complete_a2a_dispatch: 4, // mcp-cutover-negative-reference: absence
        cat_cafe_complete_event_wait: 1, // mcp-cutover-negative-reference: absence
        cat_cafe_complete_managed_hold: 2, // mcp-cutover-negative-reference: absence
      },
      'all seven raw literal occurrences remain auditable',
    );
    for (const scan of scans) {
      const classified = classifyCutoverReferences(scan, fixtureConsumers);
      assert.deepEqual(classified, { activeMatches: [], invalidEvidence: [] });
    }

    const dispatchScan = scans.find((scan) => scan.retiredName === 'cat_cafe_complete_a2a_dispatch'); // mcp-cutover-negative-reference: absence
    assert.ok(dispatchScan);
    const missingManifestBinding = classifyCutoverReferences(
      dispatchScan,
      fixtureConsumers.filter((path) => path !== fixtureConsumers[2]),
    );
    assert.equal(missingManifestBinding.activeMatches.length, 1);
    assert.match(missingManifestBinding.invalidEvidence[0] ?? '', /not listed by fixture-test consumers/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
