/**
 * F163: always_on injection — queryAlwaysOn() + SystemPromptBuilder wiring
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildInvocationContext } from '../../dist/domains/cats/services/context/SystemPromptBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 always_on injection', () => {
  let store;

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('queryAlwaysOn returns constitutional + always_on docs', async () => {
    await store.upsert([
      {
        anchor: 'docs/SOP.md',
        kind: 'plan',
        status: 'active',
        title: 'Standard Operating Procedures',
        summary: 'Iron rules and workflow discipline',
        authority: 'constitutional',
        activation: 'always_on',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'docs/features/F042.md',
        kind: 'feature',
        status: 'active',
        title: 'F042 Prompt Optimization',
        summary: 'Regular feature, not constitutional',
        authority: 'observed',
        activation: 'query',
        updatedAt: '2026-01-01',
      },
    ]);

    const results = store.queryAlwaysOn();
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'docs/SOP.md');
    assert.equal(results[0].title, 'Standard Operating Procedures');
    assert.ok(results[0].summary.includes('Iron rules'));
  });

  it('queryAlwaysOn excludes non-active docs', async () => {
    await store.upsert([
      {
        anchor: 'docs/old-rules.md',
        kind: 'plan',
        status: 'archived',
        title: 'Old Rules',
        summary: 'Archived constitutional doc',
        authority: 'constitutional',
        activation: 'always_on',
        updatedAt: '2026-01-01',
      },
    ]);

    const results = store.queryAlwaysOn();
    assert.equal(results.length, 0);
  });

  it('queryAlwaysOn excludes non-constitutional always_on docs', async () => {
    // AC-A3 guard: always_on must be constitutional
    await store.upsert([
      {
        anchor: 'docs/candidate-doc.md',
        kind: 'lesson',
        status: 'active',
        title: 'Candidate Lesson',
        summary: 'Not yet constitutional',
        authority: 'candidate',
        activation: 'always_on',
        updatedAt: '2026-01-01',
      },
    ]);

    const results = store.queryAlwaysOn();
    assert.equal(results.length, 0);
  });

  it('queryAlwaysOn returns empty when no qualifying docs', async () => {
    const results = store.queryAlwaysOn();
    assert.deepEqual(results, []);
  });
});

describe('F163 SystemPromptBuilder always_on injection', () => {
  it('injects always_on docs into prompt output', () => {
    const context = {
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      alwaysOnDocs: [{ anchor: 'docs/SOP.md', title: 'SOP Iron Rules', summary: 'Never touch Redis 6399' }],
    };

    const output = buildInvocationContext(context);
    assert.ok(output.includes('Constitutional Knowledge'), 'should contain constitutional section');
    assert.ok(output.includes('SOP Iron Rules'), 'should contain doc title');
    assert.ok(output.includes('Never touch Redis 6399'), 'should contain doc summary');
  });

  it('does not inject when alwaysOnDocs is empty', () => {
    const context = {
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      alwaysOnDocs: [],
    };

    const output = buildInvocationContext(context);
    assert.ok(!output.includes('Constitutional Knowledge'), 'should not contain constitutional section');
  });

  it('does not inject when alwaysOnDocs is undefined', () => {
    const context = {
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    };

    const output = buildInvocationContext(context);
    assert.ok(!output.includes('Constitutional Knowledge'), 'should not contain constitutional section');
  });
});
