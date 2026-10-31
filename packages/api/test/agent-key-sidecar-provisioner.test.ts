import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { ensureAgentKeySidecar } from '../src/domains/cats/services/agents/agent-key/AgentKeySidecarProvisioner.js';

const tempRoots: string[] = [];

async function makeKeyPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-agent-key-sidecar-'));
  tempRoots.push(root);
  return join(root, 'agent-keys', 'gpt-pro.secret');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentKeySidecarProvisioner', () => {
  it('preserves a valid key outside the renewal window across repeated startup', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const issued = await registry.issue(createCatId('gpt-pro'), 'default-user');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, `${issued.secret}\n`, { mode: 0o600 });

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
      renewBeforeMs: 7 * 24 * 60 * 60 * 1000,
    });

    assert.equal(result.kind, 'preserved');
    assert.equal(result.agentKeyId, issued.agentKeyId);
    assert.equal((await readFile(keyFile, 'utf8')).trim(), issued.secret);
    assert.equal((await registry.list({ catId: 'gpt-pro', userId: 'default-user' })).length, 1);
  });

  it('restores strict permissions before preserving a valid sidecar', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const issued = await registry.issue(createCatId('gpt-pro'), 'default-user');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, `${issued.secret}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o644);

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
      renewBeforeMs: 7 * 24 * 60 * 60 * 1000,
    });

    assert.equal(result.kind, 'preserved');
    assert.equal((await readFile(keyFile, 'utf8')).trim(), issued.secret);
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  });

  it('replaces an unknown stale sidecar without requiring manual deletion', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, 'expired-secret-with-no-registry-record\n', { mode: 0o600 });

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
    });

    assert.equal(result.kind, 'replaced');
    const replacementSecret = (await readFile(keyFile, 'utf8')).trim();
    assert.notEqual(replacementSecret, 'expired-secret-with-no-registry-record');
    const verified = await registry.verify(replacementSecret);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.record.agentKeyId, result.agentKeyId);
    assert.equal(verified.record.catId, 'gpt-pro');
    assert.equal(verified.record.userId, 'default-user');
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  });

  it('rotates a valid key before its TTL boundary', async () => {
    const registry = new AgentKeyRegistry({ ttlMs: 60_000, graceMs: 30_000 });
    const keyFile = await makeKeyPath();
    const issued = await registry.issue(createCatId('gpt-pro'), 'default-user');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, `${issued.secret}\n`, { mode: 0o600 });

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
      renewBeforeMs: 120_000,
    });

    assert.equal(result.kind, 'rotated');
    assert.notEqual(result.agentKeyId, issued.agentKeyId);
    const replacementSecret = (await readFile(keyFile, 'utf8')).trim();
    assert.notEqual(replacementSecret, issued.secret);
    const verified = await registry.verify(replacementSecret);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.record.agentKeyId, result.agentKeyId);
  });

  it('serializes concurrent replacement so both callers observe one canonical key', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, 'stale-secret\n', { mode: 0o600 });

    const [first, second] = await Promise.all([
      ensureAgentKeySidecar({ registry, catId: 'gpt-pro', userId: 'default-user', keyFile }),
      ensureAgentKeySidecar({ registry, catId: 'gpt-pro', userId: 'default-user', keyFile }),
    ]);

    assert.equal(first.agentKeyId, second.agentKeyId);
    assert.deepEqual(new Set([first.kind, second.kind]), new Set(['replaced', 'preserved']));
    assert.equal((await registry.list({ catId: 'gpt-pro', userId: 'default-user' })).length, 1);
  });

  it('recovers a stale provisioning lease without letting the old owner delete the replacement lease', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const leaseFile = `${keyFile}.provision.lock`;
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(leaseFile, `${JSON.stringify({ token: 'dead-owner', pid: 999_999_999, acquiredAt: 1 })}\n`, {
      mode: 0o600,
    });

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
      leaseStaleMs: 0,
    });

    assert.equal(result.kind, 'issued');
    await assert.rejects(stat(leaseFile), { code: 'ENOENT' });
  });

  it('recovers a stale reaper lock before reclaiming a stale provisioning lease', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const leaseFile = `${keyFile}.provision.lock`;
    const reaperFile = `${leaseFile}.reaper`;
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(leaseFile, `${JSON.stringify({ token: 'dead-owner', pid: 999_999_999, acquiredAt: 1 })}\n`, {
        mode: 0o600,
      }),
      writeFile(reaperFile, `${JSON.stringify({ token: 'dead-reaper', pid: 999_999_999, acquiredAt: 1 })}\n`, {
        mode: 0o600,
      }),
    ]);

    const result = await ensureAgentKeySidecar({
      registry,
      catId: 'gpt-pro',
      userId: 'default-user',
      keyFile,
      leaseStaleMs: 0,
      leaseWaitMs: 100,
    });

    assert.equal(result.kind, 'issued');
    await assert.rejects(stat(leaseFile), { code: 'ENOENT' });
    await assert.rejects(stat(reaperFile), { code: 'ENOENT' });
  });

  it('revokes a newly issued record when atomic sidecar publication fails', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();

    await assert.rejects(
      ensureAgentKeySidecar({
        registry,
        catId: 'gpt-pro',
        userId: 'default-user',
        keyFile,
        publish: async () => {
          throw new Error('simulated fsync failure');
        },
      }),
      /simulated fsync failure/,
    );

    const records = await registry.list({
      catId: 'gpt-pro',
      userId: 'default-user',
      includeRevoked: true,
    });
    assert.equal(records.length, 1);
    assert.match(records[0]?.revokedReason ?? '', /sidecar publication failed/);
    await assert.rejects(stat(keyFile), { code: 'ENOENT' });
  });

  it('keeps the published canonical key valid when stale-key cleanup fails', async () => {
    const registry = new AgentKeyRegistry();
    const keyFile = await makeKeyPath();
    const staleRecord = await registry.issue(createCatId('gpt-pro'), 'default-user');
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, 'unknown-sidecar-secret\n', { mode: 0o600 });

    const originalRevoke = registry.revoke.bind(registry);
    registry.revoke = async (agentKeyId, reason) => {
      if (agentKeyId === staleRecord.agentKeyId) throw new Error('simulated stale-key cleanup failure');
      return originalRevoke(agentKeyId, reason);
    };

    await assert.rejects(
      ensureAgentKeySidecar({
        registry,
        catId: 'gpt-pro',
        userId: 'default-user',
        keyFile,
      }),
      /simulated stale-key cleanup failure/,
    );

    const publishedSecret = (await readFile(keyFile, 'utf8')).trim();
    const verified = await registry.verify(publishedSecret);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.notEqual(verified.record.agentKeyId, staleRecord.agentKeyId);
    assert.equal(verified.record.revokedAt, undefined);
  });
});
