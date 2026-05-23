import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  parseEvalDomainRegistryEntry,
  parseEvalDomainRegistryFile,
} from '../../dist/infrastructure/harness-eval/eval-domain-registry.js';

const validEntry = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  systemThreadId: 'thread_eval_a2a',
  evalCat: {
    catId: 'codex',
    handle: '@codex',
    model: 'gpt-5.5',
  },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['harness-fit-digest'],
  handoffTargetResolver: {
    featureId: 'F167',
    ownerCatId: 'opus47',
    threadLookup: 'feature-thread',
  },
  sla: {
    acknowledgeHours: 24,
    reevalWithinHours: 72,
  },
};

describe('Eval Domain Registry v0', () => {
  it('validates the eval:a2a registry entry', () => {
    const entry = parseEvalDomainRegistryEntry(validEntry);

    assert.equal(entry.domainId, 'eval:a2a');
    assert.equal(entry.sourceAdapter, 'f167-runtime-eval');
    assert.equal(entry.threadPolicy.stateSot, 'registry');
    assert.deepEqual(entry.legacyScheduledTaskIds, ['harness-fit-digest']);
  });

  it('loads the docs-backed eval:a2a registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-a2a.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:a2a');
    assert.equal(entry.systemThreadId.length > 0, true);
    assert.equal(entry.threadPolicy.role, 'working-home');
    assert.equal(entry.sla.acknowledgeHours > 0, true);
  });

  it('rejects domain thread as the state source of truth', () => {
    assert.throws(
      () =>
        parseEvalDomainRegistryEntry({
          ...validEntry,
          threadPolicy: { ...validEntry.threadPolicy, stateSot: 'thread' },
        }),
      /registry/,
    );
  });

  it('rejects missing system thread id', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, systemThreadId: '' }), /systemThreadId/);
  });

  it('rejects empty legacy scheduled task ids', () => {
    assert.throws(
      () => parseEvalDomainRegistryEntry({ ...validEntry, legacyScheduledTaskIds: [] }),
      /legacyScheduledTaskIds/,
    );
  });

  it('rejects non-positive SLA windows', () => {
    assert.throws(
      () =>
        parseEvalDomainRegistryEntry({
          ...validEntry,
          sla: { acknowledgeHours: 0, reevalWithinHours: 72 },
        }),
      /acknowledgeHours/,
    );
  });

  it('rejects unknown domain ids in E-pilot', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, domainId: 'eval:memory' }), /eval:a2a/);
  });

  it('rejects non-F167 handoff targets in E-pilot', () => {
    assert.throws(
      () =>
        parseEvalDomainRegistryEntry({
          ...validEntry,
          handoffTargetResolver: { ...validEntry.handoffTargetResolver, featureId: 'F192' },
        }),
      /F167/,
    );
  });
});
