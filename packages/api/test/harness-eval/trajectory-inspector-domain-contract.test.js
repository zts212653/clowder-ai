import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  parseEvalDomainRegistryFile,
  parseEvalMetricGlossary,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import {
  buildEvalCatInvocation,
  hasEvalDomainInstructions,
} from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

const domainUrl = new URL(
  '../../../../docs/harness-feedback/eval-domains/eval-trajectory-inspector.yaml',
  import.meta.url,
);
const metricsUrl = new URL(
  '../../../../docs/harness-feedback/eval-domains/eval-trajectory-inspector.metrics.yaml',
  import.meta.url,
);

describe('eval:trajectory-inspector first-party domain contract', () => {
  it('registers the weekly time-only source and F299 closure owner', async () => {
    const domain = parseEvalDomainRegistryFile(parseYaml(await readFile(domainUrl, 'utf8')));
    assert.equal(domain.domainId, 'eval:trajectory-inspector');
    assert.equal(domain.systemThreadId, 'thread_eval_trajectory_inspector');
    assert.equal(domain.frequency, 'weekly');
    assert.deepEqual(domain.triggerPolicy, { mode: 'time_only', maxDetectionDelayHours: 168 });
    assert.equal(domain.sourceAdapter, 'f299-trajectory-inspector-episodes');
    assert.equal(domain.sourceRefsKind, 'trajectory-inspector-window');
    assert.deepEqual(domain.handoffTargetResolver, {
      featureId: 'F299',
      ownerCatId: 'fable5',
      threadLookup: 'feature-thread',
    });
    assert.equal(domain.enabled, true);
  });

  it('publishes a glossary for the vector and validity bounds without an opening-rate or total-score metric', async () => {
    const glossary = parseEvalMetricGlossary(parseYaml(await readFile(metricsUrl, 'utf8')));
    assert.deepEqual(Object.keys(glossary).sort(), [
      'accepted_evidence_episodes',
      'canonical_coverage',
      'eligible_episodes',
      'not_taken_episodes',
      'raw_or_jsonl_fallback_episodes',
      'reviewer_disagreement_rate',
      'time_to_first_accepted_evidence_ms',
      'unresolved_evidence_episodes',
      'wrong_ref_episodes',
    ]);
    assert.equal('opening_rate' in glossary, false);
    assert.equal('total_score' in glossary, false);
  });

  it('instructs the eval cat to preserve silent opportunities and fail closed on wrong refs', async () => {
    const domain = parseEvalDomainRegistryFile(parseYaml(await readFile(domainUrl, 'utf8')));
    assert.equal(hasEvalDomainInstructions(domain.domainId), true);
    const packet = buildEvalCatInvocation(
      {
        domain,
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'disabled' },
      },
      { wiredPublishDomains: new Set() },
    );
    assert.match(packet.instructions, /opening rate.*not utility/i);
    assert.match(packet.instructions, /not_taken.*unresolved.*denominator/i);
    assert.match(packet.instructions, /wrong invocation.*thread.*stop/i);
    assert.match(packet.instructions, /time-to-first-accepted-evidence/i);
    assert.match(packet.instructions, /Raw\/JSONL fallback/i);
    assert.match(packet.instructions, /no composite score/i);
    assert.match(packet.instructions, /fewer than 10|<10/i);
    assert.match(packet.instructions, /keep_observe/i);
    assert.doesNotMatch(packet.instructions, /cat_cafe_publish_verdict/);
  });
});
