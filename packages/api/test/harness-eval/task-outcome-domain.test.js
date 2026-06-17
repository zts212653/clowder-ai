import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import { parseEvalDomainRegistryEntry } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';
import { parseVerdictHandoffPacket } from '../../dist/infrastructure/harness-eval/verdict-handoff.js';

describe('eval:task-outcome domain registration (F192 Phase G)', () => {
  it('accepts eval:task-outcome as valid domainId in registry', () => {
    const entry = parseEvalDomainRegistryEntry({
      domainId: 'eval:task-outcome',
      displayName: 'Task Outcome Eval',
      systemThreadId: 'thread_eval_task_outcome',
      evalCat: { catId: 'opus-47', handle: '@opus47', model: 'claude-opus-4-7' },
      frequency: 'weekly',
      sourceAdapter: 'task-outcome-eval',
      threadPolicy: {
        role: 'working-home',
        stateSot: 'registry',
        allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
      },
      legacyScheduledTaskIds: [],
      handoffTargetResolver: {
        featureId: 'F192',
        ownerCatId: 'opus',
        threadLookup: 'feature-thread',
      },
      sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    });
    assert.equal(entry.domainId, 'eval:task-outcome');
    assert.equal(entry.sourceAdapter, 'task-outcome-eval');
  });

  it('loads the docs-backed eval-task-outcome.yaml registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-task-outcome.yaml', import.meta.url),
      'utf8',
    );
    const entry = parseEvalDomainRegistryEntry(parse(raw));
    assert.equal(entry.domainId, 'eval:task-outcome');
    assert.equal(entry.frequency, 'daily');
  });

  it('accepts eval:task-outcome as valid domainId in verdict handoff', () => {
    const packet = parseVerdictHandoffPacket({
      id: 'v-task-outcome-001',
      domainId: 'eval:task-outcome',
      createdAt: '2026-06-03T12:00:00.000Z',
      phenomenon: 'High cancel rate on hold_ball in thread_abc',
      harnessUnderEval: {
        featureId: 'F192',
        componentId: 'task-outcome-pipeline',
        name: 'Task Outcome Eval Pipeline',
      },
      evidencePacket: {
        snapshotRefs: ['snapshot:2026-06-03-task-outcome'],
        attributionRefs: ['attribution:cancel-rate-analysis'],
        metricRefs: ['metric:cancel_count_per_episode'],
        sampleTraceRefs: ['trace:thread_abc-ep-001'],
      },
      dailyTrend: {
        window: '2026-05-27..2026-06-03',
        current: { cancelRate: 0.35 },
        baseline: { cancelRate: 0.1 },
        threshold: { cancelRate: 0.25 },
        direction: 'regressed',
      },
      rootCauseHypothesis: {
        summary: 'Cat is over-using hold_ball when it should be passing',
        confidence: 'medium',
        alternatives: ['operator preference shift', 'Task type distribution change'],
      },
      verdict: 'fix',
      ownerAsk: {
        targetFeatureId: 'F167',
        targetOwnerCatId: 'opus-47',
        requestedAction: 'Tune hold_ball trigger criteria to reduce false holds',
      },
      acceptanceReevalPlan: {
        nextEvalAt: '2026-06-10T03:00:00.000Z',
        closureCondition: 'cancel_rate < 0.15 for 2 consecutive weeks',
      },
      counterarguments: ['Cancel rate may be noise from eval-domain threads', 'Sample size is small (N=12)'],
    });
    assert.equal(packet.domainId, 'eval:task-outcome');
  });

  it('builds eval cat invocation for eval:task-outcome', () => {
    const packet = buildEvalCatInvocation({
      domain: {
        domainId: 'eval:task-outcome',
        displayName: 'Task Outcome Eval',
        systemThreadId: 'thread_eval_task_outcome',
        evalCat: { catId: 'opus-47', handle: '@opus47', model: 'claude-opus-4-7' },
        frequency: 'weekly',
        sourceAdapter: 'task-outcome-eval',
        threadPolicy: {
          role: 'working-home',
          stateSot: 'registry',
          allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
        },
        legacyScheduledTaskIds: [],
        handoffTargetResolver: {
          featureId: 'F192',
          ownerCatId: 'opus',
          threadLookup: 'feature-thread',
        },
        sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
        fixtures: [],
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.equal(packet.domainId, 'eval:task-outcome');
    assert.ok(packet.instructions.includes('task-outcome'));
    assert.ok(packet.instructions.length > 20);
  });

  // Regression: existing domains must still parse
  it('existing eval:a2a domain still parses after extension', () => {
    const entry = parseEvalDomainRegistryEntry({
      domainId: 'eval:a2a',
      displayName: 'A2A Harness Eval',
      systemThreadId: 'thread_eval_a2a',
      evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
      frequency: 'daily',
      sourceAdapter: 'f167-runtime-eval',
      threadPolicy: {
        role: 'working-home',
        stateSot: 'registry',
        allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
      },
      legacyScheduledTaskIds: [],
      handoffTargetResolver: {
        featureId: 'F167',
        ownerCatId: 'opus-47',
        threadLookup: 'feature-thread',
      },
      sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
    });
    assert.equal(entry.domainId, 'eval:a2a');
  });
});
