import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { copyLegacyConnectorPermissions } from '../scripts/f202-legacy-permission-copy.mjs';

async function fixture(snapshot, operations) {
  const reads = [];
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    // Test session injection only. The migration module never reads this header or payload identity.
    request.sessionUserId = request.headers['x-test-session'];
  });
  const redis = {
    multi() {
      const keys = [];
      return {
        hgetall(key) {
          keys.push(key);
          return this;
        },
        async exec() {
          reads.push(keys);
          return [
            [null, structuredClone(snapshot.config)],
            [null, structuredClone(snapshot.groups)],
          ];
        },
      };
    },
  };
  app.post('/isolated-copy', async (request, reply) => {
    const result = await copyLegacyConnectorPermissions({
      request,
      redis,
      operations,
      connectorId: 'feishu',
      target: { pluginId: 'dev.fixture', operationKey: 'legacy_permissions', actionId: 'import' },
    });
    return reply.status(result.status).send(result.body);
  });
  const headers = {
    host: 'localhost:4999',
    origin: 'http://localhost:4999',
    'x-test-session': process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner',
  };
  return { app, reads, headers };
}

test('unauthenticated/payload owner and remote callers cannot read legacy hashes or invoke a plugin', async () => {
  const calls = [];
  const f = await fixture(
    { config: {}, groups: {} },
    {
      runAction: async (...args) => {
        calls.push(args);
      },
    },
  );
  try {
    const forged = await f.app.inject({
      method: 'POST',
      url: '/isolated-copy',
      headers: { host: 'localhost:4999', origin: 'http://localhost:4999' },
      payload: { ownerUserId: 'owner' },
    });
    assert.equal(forged.statusCode, 401);
    const remote = await f.app.inject({
      method: 'POST',
      url: '/isolated-copy',
      headers: { ...f.headers, origin: 'https://evil.example' },
    });
    assert.equal(remote.statusCode, 403);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(calls, []);
  } finally {
    await f.app.close();
  }
});

test('owner-authorized copy keeps both raw hashes including explicit empty and passes only snapshot to declared operation', async () => {
  const snapshot = {
    config: { whitelistEnabled: 'true', commandAdminOnly: 'false', adminOpenIds: '[]' },
    groups: { chat: JSON.stringify({ label: 'Group', addedAt: 12 }) },
  };
  const calls = [];
  const f = await fixture(snapshot, {
    runAction: async (...args) => {
      calls.push(args);
      return { status: 200, body: { ok: true, data: { receipt: 'fixture' } } };
    },
  });
  try {
    const result = await f.app.inject({
      method: 'POST',
      url: '/isolated-copy',
      headers: f.headers,
      payload: { confirmed: true, snapshot: { config: { adminOpenIds: '["attacker"]' } }, pluginId: 'other' },
    });
    assert.equal(result.statusCode, 200);
    const canonical =
      '{"config":{"adminOpenIds":"[]","commandAdminOnly":"false","whitelistEnabled":"true"},"groups":{"chat":"{\\"label\\":\\"Group\\",\\"addedAt\\":12}"}}';
    const sourceDigest = createHash('sha256').update(canonical).digest('hex');
    assert.deepEqual(calls, [
      ['dev.fixture', 'legacy_permissions', 'import', { protocolVersion: 1, sourceDigest, snapshot }],
    ]);
    assert.deepEqual(f.reads, [['connector-perm:feishu', 'connector-perm-groups:feishu']]);
    assert.equal(snapshot.config.adminOpenIds, '[]');
    assert.equal(result.json().data.receipt, 'fixture');
  } finally {
    await f.app.close();
  }
});

test('absent admins remain absent and oversize export never reaches action', async () => {
  const calls = [];
  const snapshot = { config: {}, groups: {} };
  const f = await fixture(snapshot, {
    runAction: async (...args) => {
      calls.push(args);
      return { status: 409, body: { error: 'not enabled' } };
    },
  });
  try {
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/isolated-copy', headers: f.headers, payload: { confirmed: true } }))
        .statusCode,
      409,
    );
    assert.equal(Object.hasOwn(calls[0][3].snapshot.config, 'adminOpenIds'), false);
    snapshot.groups.chat = 'x'.repeat(256 * 1024);
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/isolated-copy', headers: f.headers, payload: { confirmed: true } }))
        .statusCode,
      413,
    );
    assert.equal(calls.length, 1);
  } finally {
    await f.app.close();
  }
});

test('an authenticated owner must confirm each copy before either hash is read', async () => {
  const f = await fixture(
    { config: {}, groups: {} },
    {
      runAction: async () => {
        throw new Error('must not invoke');
      },
    },
  );
  try {
    for (const payload of [undefined, {}, { confirmed: false }, { confirmed: 'true' }]) {
      const result = await f.app.inject({ method: 'POST', url: '/isolated-copy', headers: f.headers, payload });
      assert.equal(result.statusCode, 400);
    }
    assert.deepEqual(f.reads, []);
  } finally {
    await f.app.close();
  }
});

test('digest is independent of hash insertion order and retains exact raw strings and field presence', async () => {
  const digests = [];
  for (const snapshot of [
    { config: { z: 'raw', adminOpenIds: '[]' }, groups: { 2: 'two', 10: 'ten' } },
    { groups: { 10: 'ten', 2: 'two' }, config: { adminOpenIds: '[]', z: 'raw' } },
    { config: { z: 'raw' }, groups: { 2: 'two', 10: 'ten' } },
    { config: { z: 'raw', adminOpenIds: '[ ]' }, groups: { 2: 'two', 10: 'ten' } },
  ]) {
    const f = await fixture(snapshot, {
      runAction: async (_p, _o, _a, envelope) => {
        digests.push(envelope.sourceDigest);
        assert.deepEqual(envelope.snapshot, snapshot);
        return { status: 409, body: { error: 'fixture' } };
      },
    });
    try {
      await f.app.inject({ method: 'POST', url: '/isolated-copy', headers: f.headers, payload: { confirmed: true } });
    } finally {
      await f.app.close();
    }
  }
  assert.equal(
    digests[0],
    createHash('sha256')
      .update('{"config":{"adminOpenIds":"[]","z":"raw"},"groups":{"10":"ten","2":"two"}}')
      .digest('hex'),
  );
  assert.equal(digests[0], digests[1]);
  assert.notEqual(digests[0], digests[2]);
  assert.notEqual(digests[0], digests[3]);
});

test('agreed UTF-8 permission snapshot vector produces the cross-package digest unchanged', async () => {
  const snapshot = {
    config: { whitelistEnabled: 'false', adminOpenIds: '[]', commandAdminOnly: 'true' },
    groups: {
      'chat-2': '{"label":"B","addedAt":2}',
      'chat-10': '{"label":"A","addedAt":1}',
      群: '{"label":"测试","addedAt":3}',
    },
  };
  // Independently frozen protocol vector from coordination message 388.
  // This literal deliberately differs from insertion order and preserves raw JSON strings.
  const canonical =
    '{"config":{"adminOpenIds":"[]","commandAdminOnly":"true","whitelistEnabled":"false"},"groups":{"chat-10":"{\\"label\\":\\"A\\",\\"addedAt\\":1}","chat-2":"{\\"label\\":\\"B\\",\\"addedAt\\":2}","群":"{\\"label\\":\\"测试\\",\\"addedAt\\":3}"}}';
  const expectedDigest = 'bc388bb1b9bbd528cb3cf12623e07e7929125cce0e24400edee3eb3e464a5339';
  assert.equal(Buffer.byteLength(canonical, 'utf8'), 228);
  assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), expectedDigest);
  const calls = [];
  const f = await fixture(snapshot, {
    runAction: async (...args) => {
      calls.push(args);
      return { status: 200, body: { ok: true } };
    },
  });
  try {
    const result = await f.app.inject({
      method: 'POST',
      url: '/isolated-copy',
      headers: f.headers,
      payload: { confirmed: true },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls, [
      ['dev.fixture', 'legacy_permissions', 'import', { protocolVersion: 1, sourceDigest: expectedDigest, snapshot }],
    ]);
  } finally {
    await f.app.close();
  }
});
