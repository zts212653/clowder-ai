import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogRpc } from '../src/routes/runtime-catalog-rpc.js';
import { parseAcpCatalog } from '../src/routes/runtime-model-catalog.js';

test('ACP discovery can finish a 28-second handshake without sending a model prompt', async (t) => {
  const script = `
    const methods = [];
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      methods.push(msg.method);
      if (msg.method === 'hang') return;
      console.log(JSON.stringify({id:msg.id,result:{methods}}));
    });`;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rpc = catalogRpc(process.execPath, ['-e', script], process.cwd());
  try {
    await rpc.request('initialize', {});
    t.mock.timers.tick(28_000);
    assert.deepEqual(await rpc.request('session/new', { mcpServers: [] }), {
      methods: ['initialize', 'session/new'],
    });
    const unavailable = assert.rejects(rpc.request('hang', {}), { message: 'catalog_unavailable' });
    t.mock.timers.tick(17_001);
    await unavailable;
  } finally {
    t.mock.timers.reset();
    await rpc.close();
  }
});

test('the reported default identifies its provider even when two providers use the same model name', () => {
  const session = {
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: '["custom","shared-model"]',
        options: [
          {
            group: 'official',
            name: 'Official',
            options: [{ value: '["official","shared-model"]', name: 'Shared Model' }],
          },
          {
            group: 'custom',
            name: 'Custom Gateway',
            options: [{ value: '["custom","shared-model"]', name: 'Shared Model' }],
          },
        ],
      },
    ],
  };
  const result = parseAcpCatalog(session, session);
  assert.equal(result.defaultModel, '["custom","shared-model"]');
  assert.equal(result.defaultModelStatus, 'reported');
  assert.equal(result.defaultModelLabel, 'Custom Gateway / Shared Model');
});
