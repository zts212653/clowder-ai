import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { applyConnectorSecretUpdates } from '../dist/config/connector-secret-updater.js';

describe('applyConnectorSecretUpdates', () => {
  let tmpDir;
  let envFilePath;
  /** @type {import('../dist/config/config-event-bus.js').ConfigChangeEvent[]} */
  let captured;
  let unsub;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-secret-updater-'));
    envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'EXISTING_VAR=hello\n');
    captured = [];
    unsub = configEventBus.onConfigChange((e) => captured.push(e));
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  afterEach(() => {
    unsub?.();
  });

  it('writes connector secrets to env file and process.env, then emits config change', async () => {
    const result = await applyConnectorSecretUpdates(
      [
        { name: 'FEISHU_APP_ID', value: 'cli_123' },
        { name: 'FEISHU_APP_SECRET', value: 'sec_123' },
      ],
      { envFilePath },
    );

    assert.deepEqual(result.changedKeys.sort(), ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
    assert.equal(process.env.FEISHU_APP_ID, 'cli_123');
    assert.equal(process.env.FEISHU_APP_SECRET, 'sec_123');

    const envText = readFileSync(envFilePath, 'utf8');
    assert.match(envText, /FEISHU_APP_ID=cli_123/);
    assert.match(envText, /FEISHU_APP_SECRET=sec_123/);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].source, 'secrets');
    assert.deepEqual(captured[0].changedKeys.sort(), ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  });

  it('returns no changed keys and emits no event when all values are unchanged', async () => {
    process.env.FEISHU_APP_ID = 'cli_unchanged';
    writeFileSync(envFilePath, 'FEISHU_APP_ID=cli_unchanged\n');

    const result = await applyConnectorSecretUpdates([{ name: 'FEISHU_APP_ID', value: 'cli_unchanged' }], {
      envFilePath,
    });

    assert.deepEqual(result.changedKeys, []);
    assert.equal(captured.length, 0);
  });

  it('deletes connector secrets when value is null', async () => {
    process.env.FEISHU_APP_SECRET = 'sec_remove';
    writeFileSync(envFilePath, 'FEISHU_APP_SECRET=sec_remove\n');

    const result = await applyConnectorSecretUpdates([{ name: 'FEISHU_APP_SECRET', value: null }], { envFilePath });

    assert.deepEqual(result.changedKeys, ['FEISHU_APP_SECRET']);
    assert.equal(process.env.FEISHU_APP_SECRET, undefined);
    assert.doesNotMatch(readFileSync(envFilePath, 'utf8'), /FEISHU_APP_SECRET=/);
  });
});
