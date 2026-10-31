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
 *   2. PR body includes thread coordinate for human traceability.
 *   3. Refresh does not rewrite provenance.json (census-only), so the original
 *      sourceThreadId survives.
 *
 * TDD: written RED before fix in publish-verdict.ts.
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
    let capturedStageResult;

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-09-06T10:00:00.000Z'),
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            capturedStageResult = await opts.stage(isolatedWorktree);
            return { commitSha: 'abc123', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9999' };
          },
        },
        generator: createProvenanceWritingGenerator(),
      },
      {
        packet: buildPacket({ id: 'vhp-thread-trace-001', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
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

  it('PR body includes source thread coordinate', async () => {
    seedLiveEvidence(root, 'snap-t2.yaml', 'attr-t2.yaml');
    const isolatedWorktree = makeEmptyIsolatedWorktree();
    let capturedPrBody;

    await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-09-06T10:00:01.000Z'),
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            const stageResult = await opts.stage(isolatedWorktree);
            capturedPrBody = stageResult.prBody;
            return { commitSha: 'def456', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9998' };
          },
        },
        generator: createProvenanceWritingGenerator(),
      },
      {
        packet: buildPacket({ id: 'vhp-thread-trace-002', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceThreadId: 'thread_eval_anchor_first',
        sourceRefs: { snapshotName: 'snap-t2.yaml', attributionName: 'attr-t2.yaml' },
      },
    );

    assert.ok(capturedPrBody, 'stage must produce prBody');
    assert.match(capturedPrBody, /thread_eval_anchor_first/, 'PR body must include the source thread coordinate');

    rmSync(isolatedWorktree, { recursive: true, force: true });
  });

  it('omits sourceThreadId from provenance when not provided (agent_key principal)', async () => {
    seedLiveEvidence(root, 'snap-t3.yaml', 'attr-t3.yaml');
    const isolatedWorktree = makeEmptyIsolatedWorktree();

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-09-06T10:00:02.000Z'),
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            await opts.stage(isolatedWorktree);
            return { commitSha: 'ghi789', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9997' };
          },
        },
        generator: createProvenanceWritingGenerator(),
      },
      {
        packet: buildPacket({ id: 'vhp-thread-trace-003', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
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
