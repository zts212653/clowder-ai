import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('F155 guide registry loader target validation', async () => {
  const { getAvailableGuides, getRegistryEntries, getValidGuideIds, isValidGuideTarget, loadGuideFlow } = await import(
    '../dist/domains/guides/guide-registry-loader.js'
  );
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

  test('loaded add-member flow goes straight from add-member CTA into the member editor', () => {
    const flow = loadGuideFlow('add-member');
    const createIndex = flow.steps.findIndex((step) => step.id === 'click-add-member');
    const editIndex = flow.steps.findIndex((step) => step.id === 'done');
    const editStep = flow.steps[editIndex];

    assert.ok(createIndex >= 0, 'create step should exist');
    assert.ok(editIndex > createIndex, 'editor handoff should happen after member creation');
    assert.equal(flow.steps.length, 4);
    assert.equal(editStep.target, 'member-editor.profile');
    assert.equal(editStep.advance, 'confirm');
  });

  test('loaded add-account-auth flow expands settings before targeting the accounts tab', () => {
    const flow = loadGuideFlow('add-account-auth');
    const expandSettingsIndex = flow.steps.findIndex((step) => step.id === 'expand-settings');
    const accountsIndex = flow.steps.findIndex((step) => step.id === 'go-to-accounts');
    const expandSettingsStep = flow.steps[expandSettingsIndex];
    const accountsStep = flow.steps[accountsIndex];

    assert.ok(expandSettingsIndex >= 0, 'expand-settings step should exist');
    assert.ok(accountsIndex > expandSettingsIndex, 'go-to-accounts should happen after expand-settings');
    assert.ok(expandSettingsStep, 'expand-settings step should exist');
    assert.ok(accountsStep, 'go-to-accounts step should exist');
    assert.equal(expandSettingsStep.target, 'settings.group');
    assert.equal(expandSettingsStep.advance, 'click');
    assert.equal(accountsStep.target, 'settings.accounts');
  });

  test('loaded connect-wechat flow uses the rendered weixin target ids', () => {
    const flow = loadGuideFlow('connect-wechat');
    const expandStep = flow.steps.find((step) => step.id === 'expand-wechat');
    const qrStep = flow.steps.find((step) => step.id === 'generate-qr');
    const doneStep = flow.steps.find((step) => step.id === 'done');

    assert.ok(expandStep, 'expand-wechat step should exist');
    assert.ok(qrStep, 'generate-qr step should exist');
    assert.ok(doneStep, 'done step should exist');
    assert.equal(expandStep.target, 'connector.weixin');
    assert.equal(qrStep.target, 'connector.weixin.qr-panel');
    assert.equal(doneStep.target, 'connector.weixin');
  });

  test('loaded configure-first-provider flow uses the member editor auth section after add-member', () => {
    const flow = loadGuideFlow('configure-first-provider');
    const createStep = flow.steps.find((step) => step.id === 'click-add-member');
    const authStep = flow.steps.find((step) => step.id === 'config-auth');
    const doneStep = flow.steps.find((step) => step.id === 'done');

    assert.ok(createStep, 'click-add-member step should exist');
    assert.ok(authStep, 'config-auth step should exist');
    assert.ok(doneStep, 'done step should exist');
    assert.equal(createStep.target, 'cats.add-member');
    assert.equal(authStep.target, 'member-editor.auth-config');
    assert.equal(authStep.advance, 'confirm');
    assert.equal(doneStep.target, 'member-editor.profile');
    assert.equal(doneStep.advance, 'confirm');
  });

  test('loaded edit-member-auth flow keeps save reachable during auth configuration', () => {
    const flow = loadGuideFlow('edit-member-auth');
    const selectStep = flow.steps.find((step) => step.id === 'select-member');
    const authStep = flow.steps.find((step) => step.id === 'config-auth');
    const doneStep = flow.steps.find((step) => step.id === 'done');

    assert.ok(selectStep, 'select-member step should exist');
    assert.ok(authStep, 'config-auth step should exist');
    assert.ok(doneStep, 'done step should exist');
    assert.equal(selectStep.target, 'cats.first-member');
    assert.equal(authStep.target, 'member-editor.profile');
    assert.equal(authStep.advance, 'confirm');
    assert.equal(doneStep.target, 'cats.first-member');
    assert.equal(doneStep.advance, 'confirm');
  });

  test('loaded connect-feishu flow reuses the rendered feishu connector card target', () => {
    const flow = loadGuideFlow('connect-feishu');
    const expandStep = flow.steps.find((step) => step.id === 'expand-feishu');
    const finishStep = flow.steps.find((step) => step.id === 'finish-feishu-setup');

    assert.ok(expandStep, 'expand-feishu step should exist');
    assert.ok(finishStep, 'finish-feishu-setup step should exist');
    assert.equal(expandStep.target, 'connector.feishu');
    assert.equal(expandStep.advance, 'click');
    assert.equal(finishStep.target, 'connector.feishu');
    assert.equal(finishStep.advance, 'confirm');
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

  test('returns guide catalog entries with user-facing metadata', () => {
    const guides = getAvailableGuides();
    const addMember = guides.find((guide) => guide.id === 'add-member');

    assert.deepEqual(addMember, {
      id: 'add-member',
      name: '添加成员',
      description: '引导你完成新成员的创建和配置',
      category: 'member-config',
      priority: 'P0',
      crossSystem: false,
      estimatedTime: '3min',
    });
  });

  test('filters member-edit guides when no member cards exist', () => {
    const guides = getAvailableGuides({ memberCardCount: 0 });
    assert.equal(
      guides.some((guide) => guide.id === 'edit-member-auth'),
      false,
    );
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
