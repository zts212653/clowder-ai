import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseEvalDomainRegistryEntry } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';

const evalDomainsRoot = fileURLToPath(new URL('../../../../docs/harness-feedback/eval-domains', import.meta.url));

const baseEntry = {
  domainId: 'eval:trigger-test',
  displayName: 'Trigger Test',
  systemThreadId: 'thread_eval_trigger_test',
  evalCat: { catId: 'codex-sol', handle: '@codex-sol', model: 'gpt-5.6-sol' },
  frequency: 'daily',
  sourceAdapter: 'trigger-test-source',
  sourceRefsKind: 'trigger-test-snapshot',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F192', ownerCatId: 'codex-sol', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 168 },
};

describe('eval domain trigger policy', () => {
  it('migrates legacy registry entries to cadence-derived time_only policies', () => {
    const daily = parseEvalDomainRegistryEntry(baseEntry);
    const weekly = parseEvalDomainRegistryEntry({ ...baseEntry, frequency: 'weekly' });
    const nday = parseEvalDomainRegistryEntry({ ...baseEntry, frequency: 'every-3d' });

    assert.deepEqual(daily.triggerPolicy, { mode: 'time_only', maxDetectionDelayHours: 24 });
    assert.deepEqual(weekly.triggerPolicy, { mode: 'time_only', maxDetectionDelayHours: 168 });
    assert.deepEqual(nday.triggerPolicy, { mode: 'time_only', maxDetectionDelayHours: 72 });
  });

  it('accepts a strict threshold_or_time policy for a reliable cumulative event', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...baseEntry,
      frequency: 'weekly',
      triggerPolicy: {
        mode: 'threshold_or_time',
        maxDetectionDelayHours: 168,
        cooldownHours: 24,
        eventSource: 'design-gate-source-map',
        threshold: { counter: 'eligibleEpisodes', crossingAt: 20 },
      },
    });

    assert.deepEqual(entry.triggerPolicy, {
      mode: 'threshold_or_time',
      maxDetectionDelayHours: 168,
      cooldownHours: 24,
      eventSource: 'design-gate-source-map',
      threshold: { counter: 'eligibleEpisodes', crossingAt: 20 },
    });
  });

  it('rejects invalid threshold policies and event fields on time_only', () => {
    assert.throws(() =>
      parseEvalDomainRegistryEntry({
        ...baseEntry,
        triggerPolicy: {
          mode: 'threshold_or_time',
          maxDetectionDelayHours: 24,
          cooldownHours: 1,
          eventSource: 'design-gate-source-map',
          threshold: { counter: 'eligibleEpisodes', crossingAt: 0 },
        },
      }),
    );
    assert.throws(() =>
      parseEvalDomainRegistryEntry({
        ...baseEntry,
        triggerPolicy: {
          mode: 'time_only',
          maxDetectionDelayHours: 24,
          eventSource: 'not-allowed',
        },
      }),
    );
  });

  it('requires every shipped first-party domain to declare its trigger policy explicitly', () => {
    const files = readdirSync(evalDomainsRoot).filter(
      (filename) => filename.endsWith('.yaml') && !filename.endsWith('.metrics.yaml'),
    );
    for (const filename of files) {
      const raw = parseYaml(readFileSync(`${evalDomainsRoot}/${filename}`, 'utf8'));
      assert.ok(raw.triggerPolicy, `${filename} must declare triggerPolicy`);
    }
  });
});
