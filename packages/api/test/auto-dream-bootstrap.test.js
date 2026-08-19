import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { bootstrapAutoDream, resolvePresentLoopLeaseMs } from '../dist/domains/auto-dream/bootstrap-auto-dream.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';

describe('F255 bootstrap wiring', () => {
  const tempRoots = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('uses a finite configurable awakened lease and rejects invalid runtime configuration', () => {
    assert.equal(resolvePresentLoopLeaseMs(undefined), 90 * 60_000);
    assert.equal(resolvePresentLoopLeaseMs('3600000'), 3_600_000);
    assert.throws(() => resolvePresentLoopLeaseMs('0'), /positive finite number/);
    assert.throws(() => resolvePresentLoopLeaseMs('0.5'), /positive finite number/);
    assert.throws(() => resolvePresentLoopLeaseMs('not-a-number'), /positive finite number/);
  });

  test('registers product services, template, both read surfaces, and graceful release as one unit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-auto-dream-bootstrap-'));
    tempRoots.push(dataDir);
    const app = Fastify();
    app.decorateRequest('sessionUserId', undefined);
    const catalog = new LibraryCatalog();
    const collectionStores = new Map();
    const templates = new Map();
    const dynamicDefs = new Map();
    const threads = new Map();
    const messageStore = new MessageStore();

    const result = await bootstrapAutoDream({
      app,
      dataDir,
      ownerUserId: 'owner-a',
      catalog,
      collectionStores,
      registry: { verify: async () => ({ ok: false, reason: 'unknown_invocation' }) },
      agentKeyRegistry: { verify: async () => ({ ok: false, reason: 'unknown_key' }) },
      templateRegistry: {
        register: (template) => templates.set(template.templateId, template),
        get: (templateId) => templates.get(templateId) ?? null,
      },
      dynamicTaskStore: {
        getAll: () => [...dynamicDefs.values()],
        setEnabled: (id, enabled) => {
          const def = dynamicDefs.get(id);
          if (!def) return false;
          dynamicDefs.set(id, { ...def, enabled });
          return true;
        },
        upsert: (def) => dynamicDefs.set(def.id, def),
      },
      taskRunner: { registerDynamic() {}, unregister: () => false },
      threadStore: {
        get: (id) => threads.get(id) ?? null,
        ensureThread: (id, title) => {
          const thread = threads.get(id) ?? {
            id,
            title,
            participants: [],
            createdBy: 'system',
            projectPath: 'default',
            createdAt: 1,
            lastActiveAt: 1,
          };
          threads.set(id, thread);
          return thread;
        },
        restore: () => false,
        indexForUser() {},
        addParticipants() {},
        updatePreferredCats() {},
      },
      messageStore,
      proactiveBroadcaster: { publish() {} },
    });
    await app.ready();

    assert.equal(result.services.store.constructor.name, 'AutoDreamStore');
    assert.equal(result.proactiveRelationshipService.constructor.name, 'ProactiveRelationshipService');
    assert.deepEqual(result.startupProactiveReconciliation, { reconciled: 0, failed: 0 });
    assert.equal(catalog.get('world:diary')?.ownerUserId, 'owner-a');
    assert.equal(templates.get('present-loop')?.defaultTrigger.type, 'interval');
    assert.equal(app.hasRoute({ method: 'GET', url: '/api/auto-dream/diaries' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/api/auto-dream/cats/:catId/life-settings' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/api/callbacks/auto-dream/settle' }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: '/api/callbacks/auto-dream/life-settings/preview' }), true);

    await app.close();
    assert.equal(catalog.get('world:diary'), undefined);
    assert.equal(collectionStores.has('world:diary'), false);
  });
});
