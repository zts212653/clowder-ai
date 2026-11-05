import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FilePluginCapabilityKeyring,
  PluginCapabilityTokenError,
} from '../src/domains/plugin/capability-token/plugin-capability-token.js';
import { PLUGIN_HOST_ENTRIES } from '../src/domains/plugin/host-inventory/plugin-host-layout.js';

const DAY = 24 * 60 * 60 * 1_000;

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'f202-capability-token-'));
  const path = join(root, PLUGIN_HOST_ENTRIES.capabilityKeyring);
  let clock = now;
  const service = new FilePluginCapabilityKeyring({ path, now: () => clock });
  return {
    root,
    path,
    service,
    setNow(value: number) {
      clock = value;
    },
  };
}

test('external capability tokens are self-contained EdDSA claims owned by the Host caller', async () => {
  const f = await fixture();
  const issued = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 600,
  });

  assert.match(issued.token, /^[^.]+\.[^.]+\.[^.]+$/u);
  assert.equal(issued.claims.iss, 'clowder-plugin-host');
  assert.equal(issued.claims.aud, 'plugin-external');
  assert.equal(issued.claims.sub, 'pi_current');
  assert.equal(issued.claims.cap, 'dot.external-mcp');
  assert.equal('boot' in issued.claims, false);
  assert.equal('act' in issued.claims, false);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);

  const verified = await f.service.verifyExternal(issued.token, {
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
  });
  assert.deepEqual(verified, issued.claims);
  await assert.rejects(
    f.service.verifyExternal(issued.token, {
      instanceId: 'pi_other',
      capabilityId: 'dot.external-mcp',
    }),
    (error: unknown) => error instanceof PluginCapabilityTokenError && error.code === 'TOKEN_SUBJECT_MISMATCH',
  );
});

test('native capability tokens require the exact boot and activation identities', async () => {
  const f = await fixture();
  const issued = await f.service.issueNative({
    instanceId: 'pi_native',
    capabilityId: 'mcp.primary',
    bootId: 'boot-a',
    activationId: 'activation-a',
    ttlSeconds: 300,
  });

  assert.equal(issued.claims.aud, 'plugin-native');
  assert.equal(issued.claims.boot, 'boot-a');
  assert.equal(issued.claims.act, 'activation-a');
  await f.service.verifyNative(issued.token, {
    instanceId: 'pi_native',
    capabilityId: 'mcp.primary',
    bootId: 'boot-a',
    activationId: 'activation-a',
  });
  await assert.rejects(
    f.service.verifyNative(issued.token, {
      instanceId: 'pi_native',
      capabilityId: 'mcp.primary',
      bootId: 'boot-a',
      activationId: 'activation-b',
    }),
    (error: unknown) => error instanceof PluginCapabilityTokenError && error.code === 'TOKEN_ACTIVATION_MISMATCH',
  );
  await assert.rejects(
    f.service.verifyNative(issued.token, {
      instanceId: 'pi_native',
      capabilityId: 'mcp.primary',
      bootId: 'boot-b',
      activationId: 'activation-a',
    }),
    (error: unknown) => error instanceof PluginCapabilityTokenError && error.code === 'TOKEN_BOOT_MISMATCH',
  );
});

test('fixed algorithm, issuer, audience and signature fail closed', async () => {
  const f = await fixture();
  const issued = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 600,
  });
  const [header, payload, signature] = issued.token.split('.');
  const alteredHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: issued.claims.kid, typ: 'JWT' })).toString(
    'base64url',
  );
  const alteredPayload = Buffer.from(JSON.stringify({ ...issued.claims, iss: 'other-host' })).toString('base64url');

  await assert.rejects(
    f.service.verifyExternal(`${alteredHeader}.${payload}.${signature}`, {
      instanceId: 'pi_current',
      capabilityId: 'dot.external-mcp',
    }),
    PluginCapabilityTokenError,
  );
  await assert.rejects(
    f.service.verifyExternal(`${header}.${alteredPayload}.${signature}`, {
      instanceId: 'pi_current',
      capabilityId: 'dot.external-mcp',
    }),
    PluginCapabilityTokenError,
  );
  await assert.rejects(
    f.service.verifyNative(issued.token, {
      instanceId: 'pi_current',
      capabilityId: 'dot.external-mcp',
      bootId: 'boot',
      activationId: 'act',
    }),
    (error: unknown) => error instanceof PluginCapabilityTokenError && error.code === 'TOKEN_AUDIENCE_MISMATCH',
  );
});

test('two-generation rotation never deletes a key that can verify an unexpired maximum-TTL token', async () => {
  const started = 1_800_000_000_000;
  const f = await fixture(started);
  const first = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 180 * 24 * 60 * 60,
  });

  f.setNow(started + 180 * DAY);
  const second = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 60,
  });
  assert.notEqual(second.claims.kid, first.claims.kid);
  await f.service.verifyExternal(first.token, { instanceId: 'pi_current', capabilityId: 'dot.external-mcp' });

  f.setNow(started + 360 * DAY);
  const delayed = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 60,
  });
  assert.equal(delayed.claims.kid, second.claims.kid, 'clock-skew retention delays the next rotation');

  f.setNow(started + 360 * DAY + 61_000);
  const third = await f.service.issueExternal({
    instanceId: 'pi_current',
    capabilityId: 'dot.external-mcp',
    ttlSeconds: 60,
  });
  assert.notEqual(third.claims.kid, second.claims.kid);
  const persisted = JSON.parse(await readFile(f.path, 'utf8')) as {
    current: { kid: string };
    previous?: { kid: string };
  };
  assert.equal(persisted.current.kid, third.claims.kid);
  assert.equal(persisted.previous?.kid, second.claims.kid);
  assert.notEqual(persisted.previous?.kid, first.claims.kid);
});

test('corrupt keyrings fail closed instead of silently replacing installed identity', async () => {
  const f = await fixture();
  await f.service.issueExternal({ instanceId: 'pi', capabilityId: 'cap', ttlSeconds: 60 });
  await writeFile(f.path, '{"schemaVersion":1,"current":{}}\n', { mode: 0o600 });
  await assert.rejects(
    f.service.issueExternal({ instanceId: 'pi', capabilityId: 'cap', ttlSeconds: 60 }),
    (error: unknown) => error instanceof PluginCapabilityTokenError && error.code === 'KEYRING_INVALID',
  );
});
