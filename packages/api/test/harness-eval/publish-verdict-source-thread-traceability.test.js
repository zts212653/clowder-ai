import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

/**
 * F192 verdict provenance sourceThreadId traceability contract.
 *
 * Bug: provenance.json lacks sourceThreadId (invocation-authenticated thread
 * coordinate). The eval-cat instructions promise "the answer is in
 * provenance.json → sourceThreadId" but no generator writes it.
 *
 * Contract:
 *   1. Initial publish stamps invocation-authenticated sourceThreadId into
 *      provenance.json — server-side only, not client-spoofable.
 *   2. Omitted when the principal has no thread (agent_key), never fabricated.
 *
 * F257 note: this suite arrived with the upstream sync and was written against the
 * Git publisher. Publication now writes an immutable bundle through the
 * ArtifactPublisher, so the third case ("PR body includes thread coordinate") asserts
 * a surface that no longer exists and is not carried forward — there is no PR body to
 * put a coordinate in. The traceability need it served is met by provenance.json,
 * which cases 1-2 cover. Publication is also owner-scoped in this slice, so every
 * publish supplies an ownerUserId; that is a precondition here, not the subject.
 */

function seedLiveEvidence(liveRoot, snapName, attrName) {
  mkdirSync(resolvePath(liveRoot, 'snapshots'), { recursive: true });
  mkdirSync(resolvePath(liveRoot, 'attributions'), { recursive: true });
  if (snapName) writeFileSync(resolvePath(liveRoot, 'snapshots', snapName), 'fake snap\n');
  if (attrName) writeFileSync(resolvePath(liveRoot, 'attributions', attrName), 'fake attr\n');
}

function makeEmptyIsolatedWorktree() {
  const root = mkdtempSync(`${tmpdir()}/verdict-thread-trace-`);
  seedCanonicalMeasurementCensusState(root);
  return root;
}

/** Mock generator that writes provenance.json (mimics real generator output). */
function createProvenanceWritingGenerator() {
  return async (packet, _sourceRefs, deps) => {
    const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
    const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(join(deps.harnessFeedbackRoot, 'verdicts'), { recursive: true });

    // Write provenance.json as a real generator would (no sourceThreadId — that's the pipeline's job)
    const provenance = {
      verdictId: packet.id,
      rawInputs: [{ path: `bundles/${packet.id}/snapshot.json`, sha256: 'a'.repeat(64) }],
      generatedAt: deps.publicationTime,
      generator: { name: 'mock-generator', version: '1' },
      sanitizeRulesVersion: 'test-v1',
    };
    writeFileSync(join(bundleDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    writeFileSync(verdictPath, `---\ndomain_id: ${packet.domainId}\n---\n`);

    return { verdictPath, bundleDir };
  };
}

describe('F192 verdict provenance sourceThreadId traceability', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('initial publish stamps invocation-authenticated sourceThreadId into provenance.json', async () => {
    seedLiveEvidence(root, 'snap-t1.yaml', 'attr-t1.yaml');
    const isolatedWorktree = makeEmptyIsolatedWorktree();

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-09-06T10:00:00.000Z'),
        artifactPublisher: {
          async publishArtifact({ packet, generate }) {
            const outputRoot = join(isolatedWorktree, 'docs', 'harness-feedback');
            mkdirSync(outputRoot, { recursive: true });
            const generated = await generate(outputRoot);
            return {
              artifactId: packet.id,
              verdictPath: generated.verdictPath,
              bundleDir: generated.bundleDir,
              artifactUrl: `artifact://eval-a2a/${packet.id}`,
            };
          },
        },
        generator: createProvenanceWritingGenerator(),
      },
      {
        packet: buildPacket({ id: 'vhp-thread-trace-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        ownerUserId: 'owner-trace',
        sourceThreadId: 'thread_eval_anchor_first',
        sourceRefs: { snapshotName: 'snap-t1.yaml', attributionName: 'attr-t1.yaml' },
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);

    // Provenance.json must contain the server-stamped sourceThreadId
    const provenancePath = join(isolatedWorktree, 'docs/harness-feedback/bundles/vhp-thread-trace-001/provenance.json');
    assert.ok(existsSync(provenancePath), 'provenance.json must exist');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert.equal(
      provenance.sourceThreadId,
      'thread_eval_anchor_first',
      'provenance.json must contain invocation-authenticated sourceThreadId',
    );

    // Generator's original fields must be preserved
    assert.equal(provenance.verdictId, 'vhp-thread-trace-001');
    assert.equal(provenance.generator.name, 'mock-generator');
    assert.equal(provenance.sanitizeRulesVersion, 'test-v1');

    rmSync(isolatedWorktree, { recursive: true, force: true });
  });

  it('omits sourceThreadId from provenance when not provided (agent_key principal)', async () => {
    seedLiveEvidence(root, 'snap-t3.yaml', 'attr-t3.yaml');
    const isolatedWorktree = makeEmptyIsolatedWorktree();

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-09-06T10:00:02.000Z'),
        artifactPublisher: {
          async publishArtifact({ packet, generate }) {
            const outputRoot = join(isolatedWorktree, 'docs', 'harness-feedback');
            mkdirSync(outputRoot, { recursive: true });
            const generated = await generate(outputRoot);
            return {
              artifactId: packet.id,
              verdictPath: generated.verdictPath,
              bundleDir: generated.bundleDir,
              artifactUrl: `artifact://eval-a2a/${packet.id}`,
            };
          },
        },
        generator: createProvenanceWritingGenerator(),
      },
      {
        packet: buildPacket({ id: 'vhp-thread-trace-003', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        // An artifact always has an owner; only the thread coordinate is absent here.
        ownerUserId: 'owner-trace',
        // No sourceThreadId — agent_key principal doesn't have one
        sourceRefs: { snapshotName: 'snap-t3.yaml', attributionName: 'attr-t3.yaml' },
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);

    const provenancePath = join(isolatedWorktree, 'docs/harness-feedback/bundles/vhp-thread-trace-003/provenance.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert.equal(provenance.sourceThreadId, undefined, 'provenance must NOT contain sourceThreadId when not provided');

    rmSync(isolatedWorktree, { recursive: true, force: true });
  });
});
