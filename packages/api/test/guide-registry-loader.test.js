import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('F155 guide registry loader target validation', async () => {
  const { getRegistryEntries, getValidGuideIds, isValidGuideTarget, loadGuideFlow, resolveGuideForIntent } =
    await import('../dist/domains/guides/guide-registry-loader.js');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  test('accepts registry-safe target ids', () => {
    assert.equal(isValidGuideTarget('hub.trigger'), true);
    assert.equal(isValidGuideTarget('cats.add-member'), true);
    assert.equal(isValidGuideTarget('members.row_new-confirm'), true);
  });

  test('rejects selector-breaking target ids', () => {
    assert.equal(isValidGuideTarget('bad"]div'), false);
    assert.equal(isValidGuideTarget('bad target'), false);
    assert.equal(isValidGuideTarget('bad>target'), false);
  });

  test('loaded add-member flow contains only validated targets', () => {
    const flow = loadGuideFlow('add-member');
    for (const step of flow.steps) {
      assert.equal(isValidGuideTarget(step.target), true, `step ${step.id} target should be valid`);
    }
  });

  test('loaded add-member flow waits for member profile save before completion', () => {
    const flow = loadGuideFlow('add-member');
    const createIndex = flow.steps.findIndex((step) => step.id === 'click-add-member');
    const editIndex = flow.steps.findIndex((step) => step.id === 'edit-member-profile');
    const editStep = flow.steps[editIndex];

    assert.ok(createIndex >= 0, 'create step should exist');
    assert.ok(editIndex > createIndex, 'edit step should happen after member creation');
    assert.ok(editStep, 'edit-member-profile step should exist');
    assert.equal(editStep.target, 'member-editor.profile');
    assert.equal(editStep.advance, 'confirm');
  });

  test('normalizes explicit schemaVersion: 1 on loaded flows', () => {
    const guideId = 'test-schema-v1-explicit';
    const flowPath = resolve(repoRoot, 'guides', 'flows', `${guideId}.yaml`);
    const entry = {
      id: guideId,
      name: 'Test explicit schema v1',
      description: 'Regression fixture for explicit schema version',
      flow_file: `flows/${guideId}.yaml`,
      keywords: ['explicit schema v1'],
      category: 'test',
      priority: 'P0',
      cross_system: false,
      estimated_time: '1min',
    };

    writeFileSync(
      flowPath,
      [
        'schemaVersion: 1',
        `id: ${guideId}`,
        'name: Explicit Schema V1',
        'steps:',
        '  - id: step-1',
        '    target: hub.trigger',
        '    tips: Open hub',
        '    advance: click',
        '',
      ].join('\n'),
      'utf8',
    );
    getRegistryEntries().push(entry);
    getValidGuideIds().add(guideId);

    try {
      const flow = loadGuideFlow(guideId);
      assert.equal(flow.schemaVersion, 1);
    } finally {
      getRegistryEntries().pop();
      getValidGuideIds().delete(guideId);
      rmSync(flowPath, { force: true });
    }
  });

  test('treats missing schemaVersion as implicit v1 during transition', () => {
    const guideId = 'test-schema-v1-implicit';
    const flowPath = resolve(repoRoot, 'guides', 'flows', `${guideId}.yaml`);
    const entry = {
      id: guideId,
      name: 'Test implicit schema v1',
      description: 'Regression fixture for implicit schema version',
      flow_file: `flows/${guideId}.yaml`,
      keywords: ['implicit schema v1'],
      category: 'test',
      priority: 'P0',
      cross_system: false,
      estimated_time: '1min',
    };

    writeFileSync(
      flowPath,
      [
        `id: ${guideId}`,
        'name: Implicit Schema V1',
        'steps:',
        '  - id: step-1',
        '    target: hub.trigger',
        '    tips: Open hub',
        '    advance: click',
        '',
      ].join('\n'),
      'utf8',
    );
    getRegistryEntries().push(entry);
    getValidGuideIds().add(guideId);

    try {
      const flow = loadGuideFlow(guideId);
      assert.equal(flow.schemaVersion, 1);
    } finally {
      getRegistryEntries().pop();
      getValidGuideIds().delete(guideId);
      rmSync(flowPath, { force: true });
    }
  });

  test('rejects unsupported schemaVersion values', () => {
    const guideId = 'test-schema-v2-unsupported';
    const flowPath = resolve(repoRoot, 'guides', 'flows', `${guideId}.yaml`);
    const entry = {
      id: guideId,
      name: 'Test unsupported schema version',
      description: 'Regression fixture for unsupported schema version',
      flow_file: `flows/${guideId}.yaml`,
      keywords: ['unsupported schema version'],
      category: 'test',
      priority: 'P0',
      cross_system: false,
      estimated_time: '1min',
    };

    writeFileSync(
      flowPath,
      [
        'schemaVersion: 2',
        `id: ${guideId}`,
        'name: Unsupported Schema V2',
        'steps:',
        '  - id: step-1',
        '    target: hub.trigger',
        '    tips: Open hub',
        '    advance: click',
        '',
      ].join('\n'),
      'utf8',
    );
    getRegistryEntries().push(entry);
    getValidGuideIds().add(guideId);

    try {
      assert.throws(() => loadGuideFlow(guideId), /Unsupported flow schemaVersion "2"/);
    } finally {
      getRegistryEntries().pop();
      getValidGuideIds().delete(guideId);
      rmSync(flowPath, { force: true });
    }
  });

  test('matches meaningful partial queries without requiring full keyword', () => {
    const matches = resolveGuideForIntent('添加');
    assert.equal(matches[0]?.id, 'add-member');
  });

  test('does not offer guides for single-character queries', () => {
    const matches = resolveGuideForIntent('添');
    assert.equal(matches.length, 0);
  });

  test('matches exact keyword queries regardless of reverse-match threshold', () => {
    const matches = resolveGuideForIntent('加成员');
    assert.equal(matches[0]?.id, 'add-member');
  });

  test('rejects a flow file whose internal id does not match the requested guide id', () => {
    const guideId = 'test-mismatched-flow-id';
    const flowPath = resolve(repoRoot, 'guides', 'flows', `${guideId}.yaml`);
    const entry = {
      id: guideId,
      name: 'Test mismatched flow',
      description: 'Regression fixture for mismatched flow ids',
      flow_file: `flows/${guideId}.yaml`,
      keywords: ['mismatched flow id'],
      category: 'test',
      priority: 'P0',
      cross_system: false,
      estimated_time: '1min',
    };

    writeFileSync(
      flowPath,
      [
        'id: wrong-flow-id',
        'name: Wrong Flow',
        'steps:',
        '  - id: step-1',
        '    target: hub.trigger',
        '    tips: Open hub',
        '    advance: click',
        '',
      ].join('\n'),
      'utf8',
    );
    getRegistryEntries().push(entry);
    getValidGuideIds().add(guideId);

    try {
      assert.throws(
        () => loadGuideFlow(guideId),
        /Invalid flow file for "test-mismatched-flow-id": expected id "test-mismatched-flow-id"/,
      );
    } finally {
      getRegistryEntries().pop();
      getValidGuideIds().delete(guideId);
      rmSync(flowPath, { force: true });
    }
  });
});
