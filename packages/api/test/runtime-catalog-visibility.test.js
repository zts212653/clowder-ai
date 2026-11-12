import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogRpc } from '../dist/routes/runtime-catalog-rpc.js';
import { parseAcpCatalog } from '../dist/routes/runtime-model-catalog.js';

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

test('closing discovery rejects a pending late response and reaps the owned process', async () => {
  const script = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') console.log(JSON.stringify({id:msg.id,result:{pid:process.pid}}));
      else setTimeout(() => console.log(JSON.stringify({id:msg.id,result:{late:true}})), 1000);
    });`;
  const rpc = catalogRpc(process.execPath, ['-e', script], process.cwd());
  try {
    const initialized = await rpc.request('initialize', {});
    const pending = assert.rejects(rpc.request('session/new', { mcpServers: [] }), {
      message: 'catalog_unavailable',
    });
    const closing = rpc.close();
    assert.equal(rpc.close(), closing, 'cleanup must remain idempotent while a response is pending');
    await closing;
    await pending;
    assert.throws(() => process.kill(initialized.pid, 0), 'the owned discovery process must exit');
    await assert.rejects(rpc.request('session/new', {}), { message: 'catalog_unavailable' });
  } finally {
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
