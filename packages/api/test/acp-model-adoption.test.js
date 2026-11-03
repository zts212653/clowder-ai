import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogCache } from '../dist/routes/runtime-catalog-route.js';
import { parseAcpCatalog } from '../dist/routes/runtime-model-catalog.js';

const session = (currentValue) => ({
  sessionId: 's',
  configOptions: [
    {
      id: 'model',
      category: 'model',
      currentValue,
      options: [
        { value: 'model-a', name: 'A' },
        { value: 'model-b', name: 'B' },
      ],
    },
  ],
});

test('a non-live refresh also invalidates the previous default and can recover on the next read', async () => {
  let failed = false;
  const cache = createCatalogCache(async () =>
    failed ? { status: 'unavailable', models: [] } : parseAcpCatalog(session('model-a'), session('model-a')),
  );
  const target = { kind: 'acp', command: 'client', args: [], cwd: '/project' };
  await cache('one', target);
  failed = true;
  await cache('one', target, true);
  const reopened = await cache('one', target);
  assert.equal(reopened.defaultModel, undefined);
  assert.notEqual(reopened.defaultModelStatus, 'reported');
  failed = false;
  assert.equal((await cache('one', target)).defaultModel, 'model-a');
});

test('a requested model is not reported as adopted when the actual session remains on another model', () => {
  const result = parseAcpCatalog(session('model-a'), session('model-a'), 'model-b');
  assert.equal(result.selectedModel, 'model-a');
});

test('an advertised catalog is not evidence of a configured default model', () => {
  for (const current of [undefined, '', 'unknown', '["unknown","unknown"]']) {
    const result = parseAcpCatalog(session(current), session(current));
    assert.equal(result.defaultModel, undefined);
    assert.equal(result.defaultModelStatus, 'unreported');
  }
});

test('an invalid advertised default is distinguished from an unknown default', () => {
  const result = parseAcpCatalog(session('missing'), session('missing'));
  assert.equal(result.defaultModelStatus, 'unavailable');
  assert.equal(result.defaultModel, undefined);
});

test('failed refresh keeps useful model names without reporting a stale native default as current', async () => {
  let failed = false;
  let calls = 0;
  const cache = createCatalogCache(async () => {
    calls += 1;
    if (failed) throw new Error('unavailable');
    return parseAcpCatalog(session('model-a'), session('model-a'));
  });
  const target = { kind: 'acp', command: 'client', args: [], cwd: '/project' };
  await cache('one', target);
  failed = true;
  const result = await cache('one', target, true);
  assert.equal(result.models.length, 2);
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.defaultModelStatus, 'unreported');
  const reopened = await cache('one', target);
  assert.equal(reopened.defaultModel, undefined, 'reopening must not revive the stale live cache');
  assert.notEqual(reopened.defaultModelStatus, 'reported');
  assert.equal(calls, 3, 'ordinary reads retry after a failed refresh');
  failed = false;
  const recovered = await cache('one', target);
  assert.equal(recovered.defaultModel, 'model-a');
  assert.equal(recovered.defaultModelStatus, 'reported');
  assert.equal(calls, 4);
});
