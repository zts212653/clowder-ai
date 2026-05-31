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

  it('accepts empty legacy scheduled task ids (eval:sop has no legacy tasks)', () => {
    const entry = parseEvalDomainRegistryEntry({ ...validEntry, legacyScheduledTaskIds: [] });
    assert.deepEqual(entry.legacyScheduledTaskIds, []);
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

  it('validates the eval:memory registry entry', () => {
    const memoryEntry = {
      domainId: 'eval:memory',
      displayName: 'Memory Recall & Library Health Eval',
      systemThreadId: 'thread_eval_memory',
      evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
      frequency: 'daily',
      sourceAdapter: 'f200-f188-memory-eval',
      threadPolicy: {
        role: 'working-home',
        stateSot: 'registry',
        allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
      },
      legacyScheduledTaskIds: ['memory-recall-digest'],
      handoffTargetResolver: { featureId: 'F200', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
      sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    };
    const entry = parseEvalDomainRegistryEntry(memoryEntry);
    assert.equal(entry.domainId, 'eval:memory');
    assert.equal(entry.sourceAdapter, 'f200-f188-memory-eval');
    assert.equal(entry.handoffTargetResolver.featureId, 'F200');
  });

  it('accepts F188 as handoff target feature', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      handoffTargetResolver: { ...validEntry.handoffTargetResolver, featureId: 'F188' },
    });
    assert.equal(entry.handoffTargetResolver.featureId, 'F188');
  });

  it('loads the docs-backed eval:memory registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-memory.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:memory');
    assert.equal(entry.sourceAdapter, 'f200-f188-memory-eval');
    assert.equal(entry.handoffTargetResolver.featureId, 'F200');
    assert.equal(entry.sla.acknowledgeHours, 48);
  });

  it('rejects unknown domain ids', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, domainId: 'eval:unknown' }));
  });

  it('rejects unknown source adapter', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, sourceAdapter: 'unknown-adapter' }));
  });

  it('rejects malformed feature id in handoff target', () => {
    assert.throws(() =>
      parseEvalDomainRegistryEntry({
        ...validEntry,
        handoffTargetResolver: { ...validEntry.handoffTargetResolver, featureId: 'not-a-feature' },
      }),
    );
  });

  // --- eval:sop domain extension (F192 E-sop) ---

  it('validates a valid eval:sop registry entry', () => {
    const sopEntry = {
      domainId: 'eval:sop',
      displayName: 'SOP Compliance Eval',
      systemThreadId: 'thread_eval_sop',
      evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
      frequency: 'weekly',
      sourceAdapter: 'sop-trace-eval',
      threadPolicy: {
        role: 'working-home',
        stateSot: 'registry',
        allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
      },
      legacyScheduledTaskIds: [],
      handoffTargetResolver: { featureId: 'F192', ownerCatId: 'opus', threadLookup: 'feature-thread' },
      sla: { acknowledgeHours: 48, reevalWithinHours: 336 },
    };
    const entry = parseEvalDomainRegistryEntry(sopEntry);
    assert.equal(entry.domainId, 'eval:sop');
    assert.equal(entry.sourceAdapter, 'sop-trace-eval');
    assert.equal(entry.frequency, 'weekly');
    assert.deepEqual(entry.legacyScheduledTaskIds, []);
  });

  it('accepts weekly frequency for eval:sop', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      domainId: 'eval:sop',
      frequency: 'weekly',
      sourceAdapter: 'sop-trace-eval',
      legacyScheduledTaskIds: [],
    });
    assert.equal(entry.frequency, 'weekly');
  });

  it('loads the docs-backed eval:sop registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-sop.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:sop');
    assert.equal(entry.sourceAdapter, 'sop-trace-eval');
    assert.equal(entry.frequency, 'weekly');
    assert.equal(entry.sla.reevalWithinHours, 336);
  });

  it('validates a valid eval:capability-wakeup registry entry', () => {
    const capabilityEntry = {
      domainId: 'eval:capability-wakeup',
      displayName: 'Capability Wakeup Eval',
      systemThreadId: 'thread_eval_capability_wakeup',
      evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
      frequency: 'weekly',
      sourceAdapter: 'capability-wakeup-eval',
      threadPolicy: {
        role: 'working-home',
        stateSot: 'registry',
        allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
      },
      legacyScheduledTaskIds: [],
      handoffTargetResolver: { featureId: 'F203', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
      sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
    };
    const entry = parseEvalDomainRegistryEntry(capabilityEntry);
    assert.equal(entry.domainId, 'eval:capability-wakeup');
    assert.equal(entry.sourceAdapter, 'capability-wakeup-eval');
    assert.equal(entry.frequency, 'weekly');
  });

  it('loads the docs-backed eval:capability-wakeup registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-capability-wakeup.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:capability-wakeup');
    assert.equal(entry.sourceAdapter, 'capability-wakeup-eval');
    assert.equal(entry.frequency, 'weekly');
    assert.equal(entry.handoffTargetResolver.featureId, 'F203');
  });
});
