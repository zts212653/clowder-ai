// @ts-check

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import { createMeasurementCertificateFixture } from './helpers/measurement-certificate-fixture.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const domainPath = resolve(repoRoot, 'docs/harness-feedback/eval-domains/eval-capability-tips.yaml');
const gatePath = resolve(repoRoot, 'docs/harness-feedback/registry/eval-capability-tips-enable-gate.yaml');
const certificateRef = 'docs/harness-feedback/certificates/f267-capability-tips.yaml';
const replayRef = 'docs/harness-feedback/replays/f268-capability-tips.yaml';

function validReplay() {
  return {
    kind: 'f268-capability-tips-pipeline-replay',
    schemaVersion: 1,
    domainId: 'eval:capability-tips',
    status: 'passed',
    provenance: {
      featureId: 'F268',
      sourceRevision: 'b'.repeat(40),
      generatedAt: '2026-07-18T22:00:00Z',
    },
    checks: {
      authenticatedIngress: true,
      durableReceipt: true,
      duplicateRetryNoRecount: true,
      aggregateReadback: true,
      sourceAdapterProjection: true,
    },
  };
}

describe('F268 eval:capability-tips enable gate', () => {
  it('accepts the checked-in disabled registry state without prerequisite artifacts', async () => {
    const { parseEvalDomainRegistryFile } = await import(
      '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js'
    );
    const { validateCapabilityTipsEnablement } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'
    );
    const domain = parseEvalDomainRegistryFile(parse(readFileSync(domainPath, 'utf8')));
    const gate = parse(readFileSync(gatePath, 'utf8'));

    assert.equal(domain.enabled, false);
    assert.equal(
      validateCapabilityTipsEnablement(domain, gate, () => undefined),
      null,
    );
  });

  it('blocks enabled:true when either prerequisite is missing', async () => {
    const { validateCapabilityTipsEnablement } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'
    );
    const enabledDomain = { domainId: 'eval:capability-tips', enabled: true };

    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        { domainId: 'eval:capability-tips', f267CertificateRef: null, pipelineReplayRef: null },
        () => undefined,
      ),
      /F267 certificate.*pipeline replay/i,
    );
    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: certificateRef,
          pipelineReplayRef: null,
        },
        () => undefined,
      ),
      /pipeline replay/i,
    );
  });

  it('blocks unsafe or nonexistent prerequisite refs', async () => {
    const { validateCapabilityTipsEnablement } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'
    );
    const enabledDomain = { domainId: 'eval:capability-tips', enabled: true };

    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: '../../escape.yaml',
          pipelineReplayRef: replayRef,
        },
        () => undefined,
      ),
      /safe YAML path/i,
    );
    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: certificateRef,
          pipelineReplayRef: replayRef,
        },
        () => undefined,
      ),
      /does not exist/i,
    );
  });

  it('rejects wrong-but-existing files as enablement evidence', async () => {
    const { validateCapabilityTipsEnablement } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'
    );
    const enabledDomain = { domainId: 'eval:capability-tips', enabled: true };

    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: 'docs/harness-feedback/eval-domains/eval-capability-tips.yaml',
          pipelineReplayRef: 'docs/harness-feedback/registry/eval-capability-tips-enable-gate.yaml',
        },
        (ref) => (existsSync(resolve(repoRoot, ref)) ? parse(readFileSync(resolve(repoRoot, ref), 'utf8')) : undefined),
      ),
      /F267 certificate/i,
    );

    assert.match(
      validateCapabilityTipsEnablement(
        enabledDomain,
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: certificateRef,
          pipelineReplayRef: replayRef,
        },
        () => ({ domainId: 'eval:capability-tips', enabled: false }),
      ),
      /not a valid typed evidence artifact/i,
    );
  });

  it('accepts only issued full F267 certificates and passed F268 replay artifacts', async () => {
    const { validateCapabilityTipsEnablement } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'
    );
    const certificate = await createMeasurementCertificateFixture({
      certificateId: 'f267-capability-tips-effectiveness-v1',
      bundleId: 'eval:capability-tips/capability-tips-effectiveness',
      domainId: 'eval:capability-tips',
      measurementTargetId: 'capability_tips_effectiveness',
    });
    const artifacts = new Map([
      [certificateRef, certificate],
      [replayRef, validReplay()],
    ]);

    assert.equal(
      validateCapabilityTipsEnablement(
        { domainId: 'eval:capability-tips', enabled: true },
        {
          domainId: 'eval:capability-tips',
          f267CertificateRef: certificateRef,
          pipelineReplayRef: replayRef,
        },
        (ref) => artifacts.get(ref),
      ),
      null,
    );
  });
});
