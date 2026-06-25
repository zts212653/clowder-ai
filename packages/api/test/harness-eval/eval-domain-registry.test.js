import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  parseEvalDomainRegistryEntry,
  parseEvalDomainRegistryFile,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';

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
  sourceRefsKind: 'a2a-snapshot-attribution',
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
  it('accepts an eval:friction registry entry (F245 Phase C)', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      domainId: 'eval:friction',
      displayName: 'Friction Signal Eval',
      systemThreadId: 'thread_eval_friction',
      sourceAdapter: 'f245-friction-rollup',
      sourceRefsKind: 'friction-rollup-snapshot',
      frequency: 'weekly',
      handoffTargetResolver: { featureId: 'F245', ownerCatId: 'opus48', threadLookup: 'feature-thread' },
    });
    assert.equal(entry.domainId, 'eval:friction');
    assert.equal(entry.sourceAdapter, 'f245-friction-rollup');
    assert.equal(entry.sourceRefsKind, 'friction-rollup-snapshot');
  });

  it('accepts a future eval domain without editing a central enum (Y-lite contract)', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      domainId: 'eval:anchor-first',
      displayName: 'Anchor-first Eval',
      systemThreadId: 'thread_eval_anchor_first',
      sourceAdapter: 'anchor-first-eval',
      sourceRefsKind: 'memory-recall-snapshot',
      handoffTargetResolver: { featureId: 'F236', ownerCatId: 'codex', threadLookup: 'feature-thread' },
    });

    assert.equal(entry.domainId, 'eval:anchor-first');
    assert.equal(entry.sourceAdapter, 'anchor-first-eval');
    assert.equal(entry.sourceRefsKind, 'memory-recall-snapshot');
  });

  it('validates the eval:a2a registry entry', () => {
    const entry = parseEvalDomainRegistryEntry(validEntry);

    assert.equal(entry.domainId, 'eval:a2a');
    assert.equal(entry.sourceAdapter, 'f167-runtime-eval');
    assert.equal(entry.sourceRefsKind, 'a2a-snapshot-attribution');
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
    assert.equal(entry.sourceRefsKind, 'a2a-snapshot-attribution');
    assert.equal(entry.threadPolicy.role, 'working-home');
    assert.equal(entry.sla.acknowledgeHours > 0, true);
  });

  it('loads the docs-backed eval:friction registry fixture (F245 Phase C)', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-friction.yaml', import.meta.url),
      'utf8',
    );
    const entry = parseEvalDomainRegistryFile(parse(raw));

    assert.equal(entry.domainId, 'eval:friction');
    assert.equal(entry.sourceAdapter, 'f245-friction-rollup');
    assert.equal(entry.sourceRefsKind, 'friction-rollup-snapshot');
    assert.equal(entry.frequency, 'every-3d'); // F245 PR2: 本家 3-day cadence
    assert.equal(entry.threadPolicy.role, 'working-home');
    assert.equal(entry.handoffTargetResolver.featureId, 'F245');
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
      sourceRefsKind: 'memory-recall-snapshot',
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
    assert.equal(entry.sourceRefsKind, 'memory-recall-snapshot');
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
    assert.equal(entry.sourceRefsKind, 'memory-recall-snapshot');
    assert.equal(entry.handoffTargetResolver.featureId, 'F200');
    assert.equal(entry.sla.acknowledgeHours, 48);
  });

  it('rejects malformed domain ids', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, domainId: 'anchor-first' }), /domainId/);
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, domainId: 'eval:AnchorFirst' }), /domainId/);
  });

  it('rejects malformed source adapters', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, sourceAdapter: 'bad:adapter' }), /sourceAdapter/);
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, sourceAdapter: 'BadAdapter' }), /sourceAdapter/);
  });

  it('rejects missing sourceRefsKind', () => {
    const { sourceRefsKind: _sourceRefsKind, ...missingSourceRefsKind } = validEntry;
    assert.throws(() => parseEvalDomainRegistryEntry(missingSourceRefsKind), /sourceRefsKind/);
  });

  it('accepts future sourceRefsKind slugs without editing a central enum (Y-lite contract)', () => {
    const entry = parseEvalDomainRegistryEntry({ ...validEntry, sourceRefsKind: 'anchor-first-snapshot' });
    assert.equal(entry.sourceRefsKind, 'anchor-first-snapshot');
  });

  it('rejects malformed sourceRefsKind values', () => {
    assert.throws(
      () => parseEvalDomainRegistryEntry({ ...validEntry, sourceRefsKind: 'AnchorFirstSnapshot' }),
      /sourceRefsKind/,
    );
    assert.throws(
      () => parseEvalDomainRegistryEntry({ ...validEntry, sourceRefsKind: 'anchor:first:snapshot' }),
      /sourceRefsKind/,
    );
  });

  it('rejects malformed feature id in handoff target', () => {
    assert.throws(() =>
      parseEvalDomainRegistryEntry({
        ...validEntry,
        handoffTargetResolver: { ...validEntry.handoffTargetResolver, featureId: 'not-a-feature' },
      }),
    );
  });

  // Cloud R2 P2: zero-day N-day cadence must be rejected (every-0d → threshold always negative)
  it('rejects zero-day N-day cadence (every-0d)', () => {
    assert.throws(
      () => parseEvalDomainRegistryEntry({ ...validEntry, frequency: 'every-0d' }),
      /every-\{N\}d with N >= 1/,
      'every-0d must be rejected — parseNDayFrequency returns 0 which makes the gate threshold negative',
    );
  });

  it('rejects multi-zero N-day cadence (every-000d)', () => {
    assert.throws(
      () => parseEvalDomainRegistryEntry({ ...validEntry, frequency: 'every-000d' }),
      /every-\{N\}d with N >= 1/,
    );
  });

  it('accepts valid positive N-day cadences', () => {
    for (const freq of ['every-1d', 'every-3d', 'every-7d', 'every-14d', 'every-30d']) {
      const entry = parseEvalDomainRegistryEntry({ ...validEntry, frequency: freq });
      assert.equal(entry.frequency, freq, `${freq} must be accepted`);
    }
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
      sourceRefsKind: 'sop-trace-eval',
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
    assert.equal(entry.sourceRefsKind, 'sop-trace-eval');
    assert.equal(entry.frequency, 'weekly');
    assert.deepEqual(entry.legacyScheduledTaskIds, []);
  });

  it('accepts weekly frequency for eval:sop', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      domainId: 'eval:sop',
      frequency: 'weekly',
      sourceAdapter: 'sop-trace-eval',
      sourceRefsKind: 'sop-trace-eval',
      legacyScheduledTaskIds: [],
    });
    assert.equal(entry.frequency, 'weekly');
  });

  it('loads the docs-backed eval:sop registry fixture (re-enabled 2026-06-10)', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-sop.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:sop');
    assert.equal(entry.sourceAdapter, 'sop-trace-eval');
    assert.equal(entry.sourceRefsKind, 'sop-trace-eval');
    assert.equal(entry.frequency, 'weekly');
    assert.equal(entry.sla.reevalWithinHours, 336);
    // Re-enabled: SopTrace producer + file-writer +
    // PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN['eval:sop'] all wired (F192 sop-wiring PR).
    assert.equal(entry.enabled, true, 'eval:sop is re-enabled; weekly cron must pick it up');
  });

  // --- sunset flag (silent-fire fix 2026-06-06) ---

  it('defaults `enabled` to true when the field is omitted', () => {
    const entry = parseEvalDomainRegistryEntry(validEntry);
    assert.equal(entry.enabled, true, 'omitted enabled must default to true');
  });

  it('accepts explicit `enabled: true`', () => {
    const entry = parseEvalDomainRegistryEntry({ ...validEntry, enabled: true });
    assert.equal(entry.enabled, true);
  });

  it('accepts explicit `enabled: false` (sunset flag)', () => {
    const entry = parseEvalDomainRegistryEntry({ ...validEntry, enabled: false });
    assert.equal(entry.enabled, false);
  });

  it('rejects non-boolean `enabled` value', () => {
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, enabled: 'yes' }));
    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, enabled: 1 }));
  });

  it('validates a valid eval:capability-wakeup registry entry', () => {
    const capabilityEntry = {
      domainId: 'eval:capability-wakeup',
      displayName: 'Capability Wakeup Eval',
      systemThreadId: 'thread_eval_capability_wakeup',
      evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
      frequency: 'weekly',
      sourceAdapter: 'capability-wakeup-eval',
      sourceRefsKind: 'capability-wakeup-trial-window',
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
    assert.equal(entry.sourceRefsKind, 'capability-wakeup-trial-window');
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
    assert.equal(entry.sourceRefsKind, 'capability-wakeup-trial-window');
    assert.equal(entry.frequency, 'weekly');
    assert.equal(entry.handoffTargetResolver.featureId, 'F203');
    assert.deepEqual(entry.fixtures, [
      {
        id: 'source-hygiene-memu-echo-chamber',
        featureId: 'F218',
        path: 'docs/harness-feedback/fixtures/source-hygiene-memu-echo-chamber.md',
        skill: 'source-audit',
        signal: 'high-risk external claim without provenance',
      },
    ]);
  });

  // --- eval:capability-tips domain (F244 Phase D AC-D2) ---

  it('loads the docs-backed eval:capability-tips registry fixture', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-capability-tips.yaml', import.meta.url),
      'utf8',
    );
    const parsed = parse(raw);
    const entry = parseEvalDomainRegistryFile(parsed);

    assert.equal(entry.domainId, 'eval:capability-tips');
    assert.equal(entry.displayName, 'Capability Tips Effectiveness');
    assert.equal(entry.sourceAdapter, 'capability-tips-usage');
    assert.equal(entry.sourceRefsKind, 'capability-tips-usage-window');
    assert.equal(entry.frequency, 'weekly');
    assert.equal(entry.handoffTargetResolver.featureId, 'F244');
    assert.equal(entry.handoffTargetResolver.ownerCatId, 'opus');
    assert.equal(entry.sla.acknowledgeHours, 72);
    assert.equal(entry.sla.reevalWithinHours, 336);
    // Disabled until web→API telemetry pipeline is built
    assert.equal(entry.enabled, false, 'eval:capability-tips must be disabled until trace producer is wired');
    assert.deepEqual(entry.fixtures, []);
  });
});
