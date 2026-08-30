import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

/**
 * F192 provenance traceability contract tests.
 *
 * These exercise the fail-closed sourceThreadId overlay in handlePublishVerdict:
 * when sourceThreadId is provided, provenance.json MUST exist, be valid JSON,
 * and the overlay MUST succeed. Swallowing errors here would silently ship a
 * verdict PR without its promised source thread anchor.
 */

function seedLiveEvidence(liveRoot, snapName, attrName) {
  mkdirSync(resolvePath(liveRoot, 'snapshots'), { recursive: true });
  mkdirSync(resolvePath(liveRoot, 'attributions'), { recursive: true });
  if (snapName) writeFileSync(resolvePath(liveRoot, 'snapshots', snapName), 'fake snap\n');
  if (attrName) writeFileSync(resolvePath(liveRoot, 'attributions', attrName), 'fake attr\n');
}

function makeEmptyIsolatedWorktree() {
  const root = mkdtempSync(`${tmpdir()}/provenance-test-iso-`);
  seedCanonicalMeasurementCensusState(root);
  return root;
}

function makeMockPublisher(isolatedWorktree) {
  return {
    async publishOnIsolatedWorktree(opts) {
      await opts.stage(isolatedWorktree);
      return { commitSha: 'provenance-test-sha', prUrl: 'https://example.com/pr/provenance' };
    },
  };
}

describe('handlePublishVerdict — F192 provenance overlay', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('happy path: sourceThreadId is written into provenance.json', async () => {
    seedLiveEvidence(root, 'prov-snap.yaml', 'prov-attr.yaml');
    const isoRoot = makeEmptyIsolatedWorktree();
    const mockGenerator = async (packet, _sourceRefs, deps) => {
      const bundleDir = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        resolvePath(bundleDir, 'provenance.json'),
        JSON.stringify({
          verdictId: packet.id,
          generator: { name: 'test', version: '1.0.0' },
          generatedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(`${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, '---\n---\n');
      return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir };
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: makeMockPublisher(isoRoot), generator: mockGenerator },
      {
        packet: buildPacket({ id: 'prov-happy-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'prov-snap.yaml', attributionName: 'prov-attr.yaml' },
        sourceThreadId: 'thread_test_happy_path',
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    // Read the provenance.json that was staged in the isolated worktree
    const provenancePath = resolvePath(isoRoot, 'docs/harness-feedback/bundles/prov-happy-001/provenance.json');
    assert.ok(existsSync(provenancePath), 'provenance.json must exist after stage');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert.equal(provenance.sourceThreadId, 'thread_test_happy_path');
    assert.equal(provenance.verdictId, 'prov-happy-001');
    rmSync(isoRoot, { recursive: true, force: true });
  });

  it('fail-closed: missing provenance.json when sourceThreadId provided → generator_failed', async () => {
    seedLiveEvidence(root, 'prov-snap2.yaml', 'prov-attr2.yaml');
    const isoRoot = makeEmptyIsolatedWorktree();
    // Generator that does NOT write provenance.json
    const mockGenerator = async (packet, _sourceRefs, deps) => {
      const bundleDir = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(`${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, '---\n---\n');
      return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir };
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: makeMockPublisher(isoRoot), generator: mockGenerator },
      {
        packet: buildPacket({ id: 'prov-missing-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'prov-snap2.yaml', attributionName: 'prov-attr2.yaml' },
        sourceThreadId: 'thread_test_missing',
      },
    );

    assert.ok('error' in result, 'must return error when provenance.json missing');
    assert.equal(result.error, 'generator_failed');
    assert.match(result.detail, /provenance_missing/);
    rmSync(isoRoot, { recursive: true, force: true });
  });

  it('fail-closed: malformed provenance.json when sourceThreadId provided → generator_failed', async () => {
    seedLiveEvidence(root, 'prov-snap3.yaml', 'prov-attr3.yaml');
    const isoRoot = makeEmptyIsolatedWorktree();
    const mockGenerator = async (packet, _sourceRefs, deps) => {
      const bundleDir = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(resolvePath(bundleDir, 'provenance.json'), 'NOT VALID JSON{{{');
      writeFileSync(`${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, '---\n---\n');
      return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir };
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: makeMockPublisher(isoRoot), generator: mockGenerator },
      {
        packet: buildPacket({ id: 'prov-malformed-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'prov-snap3.yaml', attributionName: 'prov-attr3.yaml' },
        sourceThreadId: 'thread_test_malformed',
      },
    );

    assert.ok('error' in result, 'must return error when provenance.json is malformed');
    assert.equal(result.error, 'generator_failed');
    rmSync(isoRoot, { recursive: true, force: true });
  });

  it('no sourceThreadId → provenance.json left untouched (no overlay attempt)', async () => {
    seedLiveEvidence(root, 'prov-snap4.yaml', 'prov-attr4.yaml');
    const isoRoot = makeEmptyIsolatedWorktree();
    const originalProvenance = { verdictId: 'prov-nothread-001', generator: { name: 'test', version: '1' } };
    const mockGenerator = async (packet, _sourceRefs, deps) => {
      const bundleDir = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(resolvePath(bundleDir, 'provenance.json'), JSON.stringify(originalProvenance));
      writeFileSync(`${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, '---\n---\n');
      return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir };
    };

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root, gitPublisher: makeMockPublisher(isoRoot), generator: mockGenerator },
      {
        packet: buildPacket({ id: 'prov-nothread-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'prov-snap4.yaml', attributionName: 'prov-attr4.yaml' },
        // sourceThreadId intentionally omitted
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    const pPath = resolvePath(isoRoot, 'docs/harness-feedback/bundles/prov-nothread-001/provenance.json');
    const provenance = JSON.parse(readFileSync(pPath, 'utf8'));
    assert.equal(provenance.sourceThreadId, undefined, 'provenance.json must not have sourceThreadId');
    rmSync(isoRoot, { recursive: true, force: true });
  });
});
