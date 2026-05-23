import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../..');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertLiveVerdictBundleRefsResolve(root) {
  const verdictDir = resolve(root, 'docs/harness-feedback/verdicts');
  const liveVerdictFiles = readdirSync(verdictDir)
    .map((fileName) => join(verdictDir, fileName))
    .filter((path) => statSync(path).isFile() && path.endsWith('.md'));

  for (const verdictPath of liveVerdictFiles) {
    const verdictId = basename(verdictPath, '.md');
    const text = readFileSync(verdictPath, 'utf8');
    if (!/feedback_type:\s*live-verdict/.test(text)) continue;

    assert.doesNotMatch(text, /docs\/harness-feedback\/snapshots\//);
    assert.doesNotMatch(text, /docs\/harness-feedback\/attributions\//);

    const bundleDir = resolve(root, 'docs/harness-feedback/bundles', verdictId);
    assert.equal(existsSync(bundleDir), true, `live verdict missing bundle: ${verdictId}`);

    const snapshotPath = join(bundleDir, 'snapshot.json');
    const attributionPath = join(bundleDir, 'attribution.json');
    const provenancePath = join(bundleDir, 'provenance.json');
    assert.equal(existsSync(snapshotPath), true, `live verdict missing bundle snapshot: ${verdictId}`);
    assert.equal(existsSync(attributionPath), true, `live verdict missing bundle attribution: ${verdictId}`);
    assert.equal(existsSync(provenancePath), true, `live verdict missing bundle provenance: ${verdictId}`);

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const attribution = JSON.parse(readFileSync(attributionPath, 'utf8'));
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert.equal(snapshot.verdictId, verdictId);
    assert.equal(attribution.verdictId, verdictId);
    assert.equal(provenance.verdictId, verdictId);
    assert.equal(typeof provenance.sanitizeRulesVersion, 'string');
    assert.ok(provenance.sanitizeRulesVersion.length > 0);
    assert.ok(Array.isArray(provenance.rawInputs));
    assert.ok(provenance.rawInputs.every((input) => /^[a-f0-9]{64}$/.test(input.sha256)));

    const snapshotRefs = [...text.matchAll(/\bsnapshot:bundle\/([^/\s)]+)\/snapshot\b/g)];
    const attributionRefs = [...text.matchAll(/\battribution:bundle\/([^/\s)]+)\/([^\s)]+)/g)];
    assert.ok(snapshotRefs.length > 0, `live verdict missing snapshot bundle ref: ${verdictId}`);
    assert.ok(attributionRefs.length > 0, `live verdict missing attribution bundle ref: ${verdictId}`);
    assert.ok(
      snapshotRefs.every((match) => match[1] === verdictId),
      `snapshot ref targets wrong bundle: ${verdictId}`,
    );

    const findingIds = new Set((attribution.findings ?? []).map((finding) => finding.id));
    for (const match of attributionRefs) {
      assert.equal(match[1], verdictId, `attribution ref targets wrong bundle: ${verdictId}`);
      const itemId = match[2];
      const resolvesToFinding = findingIds.has(itemId);
      const resolvesToNoFinding = itemId === `${attribution.evalSnapshotId}:no-finding` && attribution.noFindingRecord;
      assert.ok(resolvesToFinding || resolvesToNoFinding, `attribution ref does not resolve in bundle: ${match[0]}`);
    }
  }
}

describe('F192 E-pilot evidence artifacts', () => {
  it('does not publish representative eval:a2a data as a live verdict', () => {
    const liveVerdictPath = resolve(repoRoot, 'docs/harness-feedback/verdicts/2026-05-21-eval-a2a-pilot-verdict.md');
    const fixturePath = resolve(
      repoRoot,
      'docs/harness-feedback/verdicts/fixtures/2026-05-21-eval-a2a-contract-demo.md',
    );

    assert.equal(
      existsSync(liveVerdictPath),
      false,
      'representative E-pilot data must not be stored as a live verdict',
    );
    assert.equal(existsSync(fixturePath), true, 'contract demo fixture should be explicit');

    const fixtureText = readFileSync(fixturePath, 'utf8');
    assert.match(fixtureText, /Contract Demo Fixture/);
    assert.match(fixtureText, /representative data/i);
    assert.doesNotMatch(fixtureText, /snapshot:eval-F167-2026-05-21/);
    assert.doesNotMatch(fixtureText, /attribution:AR-2026-05-21-001/);
  });

  it('requires every live verdict snapshot/attribution ref to resolve to its committed bundle', () => {
    assertLiveVerdictBundleRefsResolve(repoRoot);
  });

  it('rejects no-finding refs that do not match the bundle eval snapshot id', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'f192-artifacts-'));
    const verdictId = '2026-05-23-eval-a2a-live-verdict';
    const verdictDir = resolve(tempRoot, 'docs/harness-feedback/verdicts');
    const bundleDir = resolve(tempRoot, 'docs/harness-feedback/bundles', verdictId);
    mkdirSync(verdictDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(verdictDir, `${verdictId}.md`),
      [
        '---',
        'feedback_type: live-verdict',
        '---',
        `- snapshot:bundle/${verdictId}/snapshot`,
        `- attribution:bundle/${verdictId}/wrong-run:no-finding`,
        '',
      ].join('\n'),
    );
    writeJson(join(bundleDir, 'snapshot.json'), {
      verdictId,
      evalSnapshotId: 'eval-F167-2026-05-23',
      components: [],
    });
    writeJson(join(bundleDir, 'attribution.json'), {
      verdictId,
      evalSnapshotId: 'eval-F167-2026-05-23',
      findings: [],
      noFindingRecord: { reason: 'clean', evidence: 'all clear' },
    });
    writeJson(join(bundleDir, 'provenance.json'), {
      verdictId,
      rawInputs: [{ sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      sanitizeRulesVersion: 'f192-e-pilot-v1',
    });

    assert.throws(() => assertLiveVerdictBundleRefsResolve(tempRoot), /attribution ref does not resolve in bundle/);
  });
});
