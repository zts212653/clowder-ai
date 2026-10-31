import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { applyHostSecretUpdates } from '../dist/config/host-secret-updater.js';

describe('applyHostSecretUpdates', () => {
  let tmpDir;
  let envFilePath;
  /** @type {import('../dist/config/config-event-bus.js').ConfigChangeEvent[]} */
  let captured;
  let unsub;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'host-secret-updater-'));
    envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'EXISTING_VAR=hello\n');
    captured = [];
    unsub = configEventBus.onConfigChange((e) => captured.push(e));
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  afterEach(() => {
    unsub?.();
  });

  it('writes Host secrets to env file and process.env, then emits config change', async () => {
    const result = await applyHostSecretUpdates(
      [
        { name: 'VAPID_PUBLIC_KEY', value: 'cli_123' },
        { name: 'VAPID_PRIVATE_KEY', value: 'sec_123' },
      ],
      { envFilePath },
    );

    assert.deepEqual(result.changedKeys.sort(), ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']);
    assert.equal(process.env.VAPID_PUBLIC_KEY, 'cli_123');
    assert.equal(process.env.VAPID_PRIVATE_KEY, 'sec_123');

    const envText = readFileSync(envFilePath, 'utf8');
    assert.match(envText, /VAPID_PUBLIC_KEY=cli_123/);
    assert.match(envText, /VAPID_PRIVATE_KEY=sec_123/);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].source, 'secrets');
    assert.deepEqual(captured[0].changedKeys.sort(), ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']);
  });

  it('returns no changed keys and emits no event when all values are unchanged', async () => {
    process.env.VAPID_PUBLIC_KEY = 'cli_unchanged';
    writeFileSync(envFilePath, 'VAPID_PUBLIC_KEY=cli_unchanged\n');

    const result = await applyHostSecretUpdates([{ name: 'VAPID_PUBLIC_KEY', value: 'cli_unchanged' }], {
      envFilePath,
    });

    assert.deepEqual(result.changedKeys, []);
    assert.equal(captured.length, 0);
  });

  it('deletes Host secrets when value is null', async () => {
    process.env.VAPID_PRIVATE_KEY = 'sec_remove';
    writeFileSync(envFilePath, 'VAPID_PRIVATE_KEY=sec_remove\n');

    const result = await applyHostSecretUpdates([{ name: 'VAPID_PRIVATE_KEY', value: null }], { envFilePath });

    assert.deepEqual(result.changedKeys, ['VAPID_PRIVATE_KEY']);
    assert.equal(process.env.VAPID_PRIVATE_KEY, undefined);
    assert.doesNotMatch(readFileSync(envFilePath, 'utf8'), /VAPID_PRIVATE_KEY=/);
  });
});
