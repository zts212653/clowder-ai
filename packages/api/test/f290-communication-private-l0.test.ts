import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compileL0, resolveUserCapsule } from '../../../scripts/compile-system-prompt-l0.mjs';
import { clearL0Cache, compileL0ViaSubprocess } from '../src/domains/cats/services/agents/providers/l0-compiler.js';
import type { SpawnFn } from '../src/utils/cli-types.js';

test('private Work compiler preserves the same complete home identity/harness and excludes only USER_CAPSULE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-l0-profile-'));
  try {
    await writeFile(
      join(directory, 'operator-capsule.md'),
      '---\nstatus: signed\n---\nPRIVATE_OWNER_PORTRAIT_CANARY\n',
    );
    const owner = await compileL0({ catId: 'codex-sol', profileDir: directory });
    const capsule = resolveUserCapsule(directory, 'maine-coon');
    assert.match(owner, /PRIVATE_OWNER_PORTRAIT_CANARY/);
    const privateWork = await compileL0({ catId: 'codex-sol', profileDir: directory, projection: 'collective-work' });
    assert.equal(privateWork, owner.replace(capsule, ''), 'the existing home template remains exact');
    assert.doesNotMatch(privateWork, /PRIVATE_OWNER_PORTRAIT_CANARY|## 主人画像/);
    assert.match(privateWork, /## 1\. 身份与伙伴声明/);
    assert.match(privateWork, /## 队友名册/);
    assert.match(privateWork, /Redis 6399/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('owner and private Work cache/inflight/subprocess projections are separate and Work receives no profile directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-l0-cache-'));
  const calls: string[][] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    calls.push([...args]);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    Object.assign(child, { stdout, stderr: new EventEmitter() });
    setImmediate(() => {
      stdout.emit(
        'data',
        Buffer.from(args.includes('collective-work') ? 'PRIVATE_HOME_SAFE' : 'OWNER_PORTRAIT_CANARY'),
      );
      child.emit('close', 0);
    });
    return child as ReturnType<SpawnFn>;
  };
  try {
    clearL0Cache();
    await mkdir(join(directory, 'profiles/users/fixture-owner'), { recursive: true });
    const options = {
      catId: 'codex-sol',
      userId: 'fixture-owner',
      dataDir: directory,
      cwd: resolve(import.meta.dirname, '../../..'),
      spawnFn,
    };
    const [owner, privateWork] = await Promise.all([
      compileL0ViaSubprocess(options),
      compileL0ViaSubprocess({ ...options, projection: 'collective-work' }),
    ]);
    assert.equal(owner, 'OWNER_PORTRAIT_CANARY');
    assert.equal(privateWork, 'PRIVATE_HOME_SAFE');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes('--profile-dir'), false);
    assert.deepEqual(calls[1].slice(-2), ['--projection', 'collective-work']);
    assert.equal(await compileL0ViaSubprocess({ ...options, projection: 'collective-work' }), 'PRIVATE_HOME_SAFE');
    assert.equal(calls.length, 2, 'warm private cache cannot resolve to the concurrently compiled owner bytes');
  } finally {
    clearL0Cache();
    await rm(directory, { recursive: true, force: true });
  }
});
