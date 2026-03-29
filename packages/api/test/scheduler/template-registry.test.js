/**
 * F139 Phase 3A: Template Registry + MVP Templates
 * AC-G1 (template matching) + AC-G5 (≥3 templates)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';

describe('TemplateRegistry', () => {
  test('has at least 3 MVP templates', () => {
    const templates = templateRegistry.list();
    assert.ok(templates.length >= 3, `Expected ≥3 templates, got ${templates.length}`);
  });

  test('each template has required fields', () => {
    for (const t of templateRegistry.list()) {
      assert.ok(t.templateId, 'templateId required');
      assert.ok(t.label, 'label required');
      assert.ok(t.category, 'category required');
      assert.ok(t.description, 'description required');
      assert.ok(t.defaultTrigger, 'defaultTrigger required');
      assert.ok(typeof t.createSpec === 'function', 'createSpec must be function');
    }
  });

  test('get() returns template by id', () => {
    const t = templateRegistry.get('reminder');
    assert.ok(t);
    assert.equal(t.templateId, 'reminder');
  });

  test('get() returns null for unknown id', () => {
    assert.equal(templateRegistry.get('nonexistent'), null);
  });

  test('reminder template creates valid TaskSpec', () => {
    const t = templateRegistry.get('reminder');
    const spec = t.createSpec('dyn-test-1', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: '检查 backlog' },
      deliveryThreadId: 'thread-abc',
    });
    assert.equal(spec.id, 'dyn-test-1');
    assert.equal(spec.profile, 'awareness');
    assert.deepEqual(spec.trigger, { type: 'cron', expression: '0 9 * * *' });
    assert.ok(spec.admission.gate, 'gate function required');
    assert.ok(spec.run.execute, 'execute function required');
    assert.ok(spec.display);
  });

  test('web-digest template creates valid TaskSpec', () => {
    const t = templateRegistry.get('web-digest');
    const spec = t.createSpec('dyn-test-2', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com', topic: 'news' },
      deliveryThreadId: 'thread-def',
    });
    assert.equal(spec.id, 'dyn-test-2');
    assert.ok(spec.admission.gate);
    assert.ok(spec.run.execute);
  });

  test('repo-activity template creates valid TaskSpec', () => {
    const t = templateRegistry.get('repo-activity');
    const spec = t.createSpec('dyn-test-3', {
      trigger: { type: 'interval', ms: 3600_000 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: 'thread-ghi',
    });
    assert.equal(spec.id, 'dyn-test-3');
    assert.ok(spec.admission.gate);
    assert.ok(spec.run.execute);
  });

  // Phase 4: reminder gate is now live — returns run:true when deliveryThreadId set
  test('reminder gate returns run=true with deliveryThreadId (Phase 4)', async () => {
    const t = templateRegistry.get('reminder');
    const spec = t.createSpec('dyn-gate-test', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'hello' },
      deliveryThreadId: 'thread-xyz',
    });
    const result = await spec.admission.gate({ taskId: 'dyn-gate-test', lastRunAt: null, tickCount: 0 });
    assert.equal(result.run, true, 'reminder gate should be live with deliveryThreadId');
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].subjectKey, 'thread-thread-xyz');
  });

  // Phase 4: web-digest gate is now live — returns run:true when url + deliveryThreadId set
  test('web-digest gate returns run=true with url + deliveryThreadId (Phase 4)', async () => {
    const t = templateRegistry.get('web-digest');
    const spec = t.createSpec('dyn-stub-wd', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com' },
      deliveryThreadId: 'thread-xyz',
    });
    const result = await spec.admission.gate({ taskId: 'dyn-stub-wd', lastRunAt: null, tickCount: 0 });
    assert.equal(result.run, true, 'web-digest gate should be live with url + deliveryThreadId');
    assert.equal(result.workItems.length, 1);
  });

  // Phase 4: repo-activity gate is now live
  test('repo-activity gate returns run=true with repo + deliveryThreadId (Phase 4)', async () => {
    const t = templateRegistry.get('repo-activity');
    const spec = t.createSpec('dyn-stub-ra', {
      trigger: { type: 'interval', ms: 3600000 },
      params: { repo: 'owner/repo' },
      deliveryThreadId: 'thread-xyz',
    });
    const result = await spec.admission.gate({ taskId: 'dyn-stub-ra', lastRunAt: null, tickCount: 0 });
    assert.equal(result.run, true, 'repo-activity gate should be live with repo + deliveryThreadId');
    assert.equal(result.workItems.length, 1);
  });
});
