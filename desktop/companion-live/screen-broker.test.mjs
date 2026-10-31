import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { createScreenBroker, readSharedScreen } from './screen-broker.mjs';

test('only the active native turn can retrieve a currently granted frame; revocation is immediate', async () => {
  let frame = { frameId: 'synthetic', image: 'data:image/jpeg;base64,/9j/AA==' };
  const broker = await createScreenBroker(
    () => frame,
    (meta) => meta.threadId === 'native' && meta.turnId === 'active',
  );
  try {
    assert.equal((await stat(broker.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readSharedScreen(broker.path, { threadId: 'native', turnId: 'active' }), { frame });
    assert.ok((await readSharedScreen(broker.path, { threadId: 'native', turnId: 'old' })).error);
    frame = undefined;
    assert.ok((await readSharedScreen(broker.path, { threadId: 'native', turnId: 'active' })).error);
  } finally {
    await broker.close();
  }
  await assert.rejects(readSharedScreen(broker.path, { threadId: 'native', turnId: 'active' }));
});
