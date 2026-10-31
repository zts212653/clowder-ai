import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { assertCompanionWorkProject } from '../src/domains/concierge/live/host/companion-work-port.js';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

async function fixture(t: TestContext, owner = 'beta25-owner') {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  const config = { ...CONCIERGE_CONFIG_DEFAULTS, ballSize: 43, dutyCatProfileId: 'codex61-sol' };
  app.get('/api/concierge/config', async () => ({
    status: 'available',
    config,
    selectedCompanionStatus: 'available',
    companions: [{ catProfileId: 'codex61-sol', displayName: 'Sol', available: true }],
  }));
  t.after(() => app.close());
  return {
    config,
    options: {
      app,
      ownerUserId: owner,
      origin: 'http://localhost:5102',
      assertCurrent: async () => {},
      publicCompanionV2: true,
      openConversation: async () => true,
    },
  };
}

test('Host uses its admitted contract to read 43 for beta.25 and 48 for beta.23/24 without writing', async (t) => {
  const f = await fixture(t);
  for (const contract of ['0.1.0-beta.23', '0.1.0-beta.24', '0.1.0-beta.25'] as const) {
    const bridge = new CompanionHostBridge({ ...f.options, companionContract: contract });
    const reply = await bridge.request({ kind: 'settings.read' });
    assert.equal(reply.kind, 'settings');
    if (reply.kind !== 'settings' || reply.status !== 'available') assert.fail('settings must be available');
    assert.equal(reply.values.ballSize, contract === '0.1.0-beta.25' ? 43 : 48);
    assert.equal(f.config.ballSize, 43);
    await bridge.close();
  }
});

test('work port receives only the opaque reference and preserves each actual navigation outcome', async (t) => {
  const f = await fixture(t);
  for (const delivery of ['applied', 'queued', 'blocked', 'unconfirmed'] as const) {
    const seen: string[] = [];
    const bridge = new CompanionHostBridge({
      ...f.options,
      companionContract: '0.1.0-beta.25',
      work: {
        read: async () => ({ kind: 'error', code: 'unavailable' }),
        reset() {},
        open: async (ref: string) => {
          seen.push(ref);
          return delivery;
        },
      },
    });
    assert.deepEqual(await bridge.request({ kind: 'work.open', entryRef: 'a'.repeat(64) }), {
      kind: 'navigation',
      delivery,
    });
    assert.deepEqual(seen, ['a'.repeat(64)]);
    assert.deepEqual(await bridge.request({ kind: 'work.open', entryRef: 'a'.repeat(64), projectPath: '/other' }), {
      kind: 'error',
      code: 'invalid_request',
    });
    assert.equal(seen.length, 1);
    await bridge.close();
  }
});

test('missing work owner and rejected source never become applied', async (t) => {
  const f = await fixture(t);
  const missing = new CompanionHostBridge({ ...f.options, companionContract: '0.1.0-beta.25' });
  assert.deepEqual(await missing.request({ kind: 'work.read' }), { kind: 'error', code: 'unavailable' });
  assert.deepEqual(await missing.request({ kind: 'work.open', entryRef: 'a'.repeat(64) }), {
    kind: 'navigation',
    delivery: 'blocked',
  });
  const failed = new CompanionHostBridge({
    ...f.options,
    companionContract: '0.1.0-beta.25',
    work: {
      read: async () => {
        throw new Error('source unavailable');
      },
      reset() {},
      open: async () => {
        throw new Error('display unconfirmed');
      },
    },
  });
  assert.deepEqual(await failed.request({ kind: 'work.open', entryRef: 'a'.repeat(64) }), {
    kind: 'navigation',
    delivery: 'unconfirmed',
  });
  await missing.close();
  await failed.close();
});

test('closing the bound bridge retires work references and blocks a late display receipt', async (t) => {
  const f = await fixture(t);
  let resets = 0;
  let resolve!: (delivery: 'applied') => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const pending = new Promise<'applied'>((done) => {
    resolve = done;
  });
  const bridge = new CompanionHostBridge({
    ...f.options,
    companionContract: '0.1.0-beta.25',
    work: {
      read: async () => ({}),
      reset: () => {
        resets++;
      },
      open: () => {
        entered();
        return pending;
      },
    },
  });
  const opening = bridge.request({ kind: 'work.open', entryRef: 'a'.repeat(64) });
  assert.equal(await Promise.race([started.then(() => true), opening.then(() => false)]), true);
  await bridge.close();
  resolve('applied');
  assert.deepEqual(await opening, { kind: 'navigation', delivery: 'blocked' });
  assert.equal(resets, 1);
});

test('work read validates the owner projection and preserves nullable actors and real version state', async (t) => {
  const f = await fixture(t);
  let reply: unknown = {
    kind: 'work',
    v: 1,
    status: 'available',
    observedAt: 100,
    scope: { kind: 'current-project', label: 'synthetic project' },
    coverage: ['tasks', 'messages', 'artifacts'].map((source) => ({ source, status: 'available' })),
    active: [
      {
        entryRef: 'a'.repeat(64),
        title: 'working',
        actor: null,
        activity: 'working',
        taskId: 'task-1',
        homeThreadId: 'thread-1',
        sourceRef: 'task:work:task-1',
        updatedAt: 100,
      },
    ],
    recentDeliveries: [
      {
        entryRef: 'b'.repeat(64),
        title: 'v1',
        taskId: 'task-1',
        homeThreadId: 'thread-1',
        sourceRef: 'message:thread-1:message-1',
        deliveredAt: 100,
        artifact: { artifactId: 'content-1', version: '1', versionState: 'superseded' },
      },
    ],
  };
  const bridge = new CompanionHostBridge({
    ...f.options,
    companionContract: '0.1.0-beta.25',
    work: { read: async () => reply, open: async () => 'unconfirmed', reset() {} },
  });
  assert.deepEqual(await bridge.request({ kind: 'work.read' }), reply);
  reply = { kind: 'work', v: 1, status: 'available' };
  assert.deepEqual(await bridge.request({ kind: 'work.read' }), { kind: 'error', code: 'unavailable' });
  await bridge.close();
});

test('lease rejection resets the work capability before refusing navigation', async (t) => {
  const f = await fixture(t);
  let resets = 0;
  let opens = 0;
  const bridge = new CompanionHostBridge({
    ...f.options,
    companionContract: '0.1.0-beta.25',
    assertCurrent: async () => {
      throw new Error('lease unavailable');
    },
    work: {
      read: async () => ({}),
      open: async () => {
        opens++;
        return 'applied';
      },
      reset: () => {
        resets++;
      },
    },
  });
  assert.deepEqual(await bridge.request({ kind: 'work.open', entryRef: 'a'.repeat(64) }), {
    kind: 'navigation',
    delivery: 'unconfirmed',
  });
  assert.equal(opens, 0);
  assert.equal(resets, 1);
  await bridge.close();
});

test('a project switch retires real C-issued references even after returning to the original project', async (t) => {
  const f = await fixture(t, 'owner');
  const source = await workFixture(t);
  await source.admit('project-binding');
  let currentProject = source.options.projectPath;
  let opens = 0;
  const assertCurrent = async () => assertCompanionWorkProject(source.options.projectPath, currentProject);
  const work = new CompanionWorkOverview({
    ...source.options,
    assertCurrent,
    open: async () => {
      opens++;
      return 'applied';
    },
  });
  const bridge = new CompanionHostBridge({ ...f.options, companionContract: '0.1.0-beta.25', work, assertCurrent });
  const read = await bridge.request({ kind: 'work.read' });
  if (read.kind !== 'work') assert.fail('the real C work projection must pass beta.25 validation');
  const entryRef = read.active[0]?.entryRef;
  assert.ok(entryRef);
  currentProject = '/synthetic/other';
  assert.deepEqual(await bridge.request({ kind: 'work.open', entryRef }), { kind: 'navigation', delivery: 'blocked' });
  currentProject = source.options.projectPath;
  assert.deepEqual(await bridge.request({ kind: 'work.open', entryRef }), { kind: 'navigation', delivery: 'blocked' });
  assert.equal(opens, 0);
  await bridge.close();
});
