/**
 * F139 Phase 3B: PackTemplateStore — pack template install/uninstall (AC-D3)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

let db;

describe('PackTemplateStore', () => {
  let PackTemplateStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);
    const mod = await import('../../dist/infrastructure/scheduler/PackTemplateStore.js');
    PackTemplateStore = mod.PackTemplateStore;
  });

  const validDef = {
    templateId: 'pack:quant-cats:morning-digest',
    packId: 'quant-cats',
    label: 'Morning Digest',
    description: 'Summarize overnight market moves',
    category: 'signal',
    subjectKind: 'thread',
    defaultTrigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    paramSchema: { topic: { type: 'string', required: true, description: 'Topic to watch' } },
    builtinTemplateRef: 'web-digest',
  };

  test('install stores a pack template definition', () => {
    const store = new PackTemplateStore(db);
    store.install(validDef);
    const got = store.get(validDef.templateId);
    assert.ok(got);
    assert.equal(got.templateId, validDef.templateId);
    assert.equal(got.packId, 'quant-cats');
    assert.equal(got.builtinTemplateRef, 'web-digest');
  });

  test('install rejects non-namespaced templateId', () => {
    const store = new PackTemplateStore(db);
    assert.throws(() => store.install({ ...validDef, templateId: 'no-namespace' }), /must start with pack:/i);
  });

  test('install rejects mismatched packId in templateId', () => {
    const store = new PackTemplateStore(db);
    assert.throws(
      () => store.install({ ...validDef, templateId: 'pack:other-pack:morning-digest' }),
      /namespace mismatch/i,
    );
  });

  test('install rejects duplicate templateId', () => {
    const store = new PackTemplateStore(db);
    store.install(validDef);
    assert.throws(() => store.install(validDef), /already installed/i);
  });

  test('uninstall removes a pack template', () => {
    const store = new PackTemplateStore(db);
    store.install(validDef);
    const removed = store.uninstall(validDef.templateId);
    assert.equal(removed, true);
    assert.equal(store.get(validDef.templateId), null);
  });

  test('uninstall returns false for missing template', () => {
    const store = new PackTemplateStore(db);
    assert.equal(store.uninstall('pack:x:y'), false);
  });

  test('listByPack returns only templates for that pack', () => {
    const store = new PackTemplateStore(db);
    store.install(validDef);
    store.install({
      ...validDef,
      templateId: 'pack:quant-cats:evening-report',
      label: 'Evening Report',
    });
    store.install({
      ...validDef,
      templateId: 'pack:other:task',
      packId: 'other',
      label: 'Other Task',
    });

    const qcTemplates = store.listByPack('quant-cats');
    assert.equal(qcTemplates.length, 2);
    assert.ok(qcTemplates.every((t) => t.packId === 'quant-cats'));
  });

  test('listAll returns all templates', () => {
    const store = new PackTemplateStore(db);
    store.install(validDef);
    store.install({
      ...validDef,
      templateId: 'pack:other:task',
      packId: 'other',
      label: 'Other Task',
    });
    assert.equal(store.listAll().length, 2);
  });
});
