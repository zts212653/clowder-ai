/**
 * F139 Phase 3B: Pack Template API Routes (AC-D3)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

let db, app, packTemplateStore;

describe('Pack Template Routes (AC-D3)', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);

    const { PackTemplateStore } = await import('../../dist/infrastructure/scheduler/PackTemplateStore.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { scheduleRoutes } = await import('../../dist/routes/schedule.js');

    packTemplateStore = new PackTemplateStore(db);
    const ledger = new RunLedger(db);

    // Minimal mock runner
    const taskRunner = {
      getTaskSummaries: () => [],
      getRegisteredTasks: () => [],
      getLedger: () => ledger,
      triggerNow: async () => {},
    };

    // Mock template registry with one builtin template
    const templateRegistry = {
      get: (id) => (id === 'web-digest' ? { templateId: 'web-digest' } : null),
      list: () => [{ templateId: 'web-digest' }],
    };

    // Mock dynamic task store — for checking active instances
    const dynamicTaskStore = {
      getAll: () => [],
    };

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, {
      taskRunner,
      packTemplateStore,
      templateRegistry,
      dynamicTaskStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  const validPayload = {
    templateId: 'pack:quant-cats:morning-digest',
    packId: 'quant-cats',
    label: 'Morning Digest',
    description: 'Summarize overnight market moves',
    category: 'signal',
    subjectKind: 'thread',
    defaultTrigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    paramSchema: { topic: { type: 'string', required: true, description: 'Topic' } },
    builtinTemplateRef: 'web-digest',
  };

  test('POST /api/schedule/pack-templates installs a pack template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedule/pack-templates',
      payload: validPayload,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.template.templateId, validPayload.templateId);

    // Verify in store
    const stored = packTemplateStore.get(validPayload.templateId);
    assert.ok(stored);
  });

  test('POST rejects unknown builtinTemplateRef', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedule/pack-templates',
      payload: { ...validPayload, builtinTemplateRef: 'unknown-template' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('unknown'));
  });

  test('POST rejects invalid namespace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedule/pack-templates',
      payload: { ...validPayload, templateId: 'no-pack-prefix' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /api/schedule/pack-templates lists all pack templates', async () => {
    packTemplateStore.install(validPayload);
    const res = await app.inject({
      method: 'GET',
      url: '/api/schedule/pack-templates',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.templates.length, 1);
    assert.equal(body.templates[0].templateId, validPayload.templateId);
  });

  test('DELETE /api/schedule/pack-templates/:id uninstalls', async () => {
    packTemplateStore.install(validPayload);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/schedule/pack-templates/${encodeURIComponent(validPayload.templateId)}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(packTemplateStore.get(validPayload.templateId), null);
  });

  test('DELETE returns 404 for missing template', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/schedule/pack-templates/pack%3Ax%3Ay',
    });
    assert.equal(res.statusCode, 404);
  });

  test('P1-D3: POST install also registers into templateRegistry', async () => {
    // Re-create app with a real-ish templateRegistry that tracks register() calls
    await app.close();
    const { scheduleRoutes } = await import('../../dist/routes/schedule.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const registered = new Map();
    const mockRegistry = {
      get: (id) =>
        registered.get(id) ?? (id === 'web-digest' ? { templateId: 'web-digest', createSpec: () => ({}) } : null),
      list: () => [...registered.values()],
      register: (template) => registered.set(template.templateId, template),
    };

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, {
      taskRunner: {
        getTaskSummaries: () => [],
        getRegisteredTasks: () => [],
        getLedger: () => new RunLedger(db),
        triggerNow: async () => {},
      },
      packTemplateStore,
      templateRegistry: mockRegistry,
      dynamicTaskStore: { getAll: () => [] },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/schedule/pack-templates',
      payload: validPayload,
    });
    assert.equal(res.statusCode, 200);

    // Pack template should now be registered in templateRegistry
    const tmpl = mockRegistry.get(validPayload.templateId);
    assert.ok(tmpl, 'pack template should be registered in templateRegistry after install');
    assert.equal(tmpl.templateId, validPayload.templateId);
  });

  test('P1-D3: DELETE uninstall removes from runtime templateRegistry', async () => {
    // Re-create app with a real-ish templateRegistry that tracks register/unregister
    await app.close();
    const { scheduleRoutes } = await import('../../dist/routes/schedule.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const registered = new Map();
    const mockRegistry = {
      get: (id) =>
        registered.get(id) ?? (id === 'web-digest' ? { templateId: 'web-digest', createSpec: () => ({}) } : null),
      list: () => [...registered.values()],
      register: (template) => registered.set(template.templateId, template),
      unregister: (id) => registered.delete(id),
    };

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, {
      taskRunner: {
        getTaskSummaries: () => [],
        getRegisteredTasks: () => [],
        getLedger: () => new RunLedger(db),
        triggerNow: async () => {},
      },
      packTemplateStore,
      templateRegistry: mockRegistry,
      dynamicTaskStore: { getAll: () => [] },
    });
    await app.ready();

    // Install
    const installRes = await app.inject({
      method: 'POST',
      url: '/api/schedule/pack-templates',
      payload: validPayload,
    });
    assert.equal(installRes.statusCode, 200);
    assert.ok(mockRegistry.get(validPayload.templateId), 'should be in registry after install');

    // Uninstall
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/schedule/pack-templates/${encodeURIComponent(validPayload.templateId)}`,
    });
    assert.equal(deleteRes.statusCode, 200);

    // Registry should no longer have the template
    assert.equal(mockRegistry.get(validPayload.templateId), null, 'should be removed from registry after uninstall');
  });

  test('DELETE blocks when active instances exist', async () => {
    packTemplateStore.install(validPayload);

    // Re-create app with dynamicTaskStore that has an active instance
    await app.close();
    const { scheduleRoutes } = await import('../../dist/routes/schedule.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, {
      taskRunner: {
        getTaskSummaries: () => [],
        getRegisteredTasks: () => [],
        getLedger: () => new RunLedger(db),
        triggerNow: async () => {},
      },
      packTemplateStore,
      templateRegistry: {
        get: (id) => (id === 'web-digest' ? { templateId: 'web-digest' } : null),
        list: () => [],
      },
      dynamicTaskStore: {
        getAll: () => [{ templateId: validPayload.templateId, enabled: true }],
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/schedule/pack-templates/${encodeURIComponent(validPayload.templateId)}`,
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('active'));
  });
});
