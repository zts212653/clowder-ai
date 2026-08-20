import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import {
  ensureGptProAgentKeySidecar,
  resolveGptProAgentKeyFile,
} from '../src/domains/cats/services/agents/agent-key/gpt-pro-agent-key-sidecar.js';

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('gpt-pro agent-key sidecar', () => {
  it('resolves its default beneath the canonical data root', () => {
    assert.equal(
      resolveGptProAgentKeyFile({ CAT_CAFE_DATA_DIR: '/srv/cat-cafe-data' }, '/unused-home'),
      '/srv/cat-cafe-data/agent-keys/gpt-pro.secret',
    );
    assert.equal(
      resolveGptProAgentKeyFile(
        {
          CAT_CAFE_DATA_DIR: '/srv/cat-cafe-data',
          CAT_CAFE_GPT_PRO_AGENT_KEY_FILE: '/run/secrets/gpt-pro',
        },
        '/unused-home',
      ),
      '/run/secrets/gpt-pro',
    );
    assert.equal(
      resolveGptProAgentKeyFile({ CAT_CAFE_DATA_DIR: '~/.cat-cafe-custom' }, '/home/cat'),
      '/home/cat/.cat-cafe-custom/agent-keys/gpt-pro.secret',
    );
    assert.equal(
      resolveGptProAgentKeyFile({ CAT_CAFE_GPT_PRO_AGENT_KEY_FILE: '~/secrets/gpt-pro' }, '/home/cat'),
      '/home/cat/secrets/gpt-pro',
    );
  });

  it('replaces a stale installed sidecar without exporting gpt-pro into shared agent env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-gpt-pro-key-'));
    tempRoots.push(root);
    const filePath = join(root, 'agent-keys', 'gpt-pro.secret');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'agent-keys'), { recursive: true, mode: 0o700 });
    await writeFile(filePath, 'expired-gpt-pro-key\n', { mode: 0o600 });
    const registry = new AgentKeyRegistry();
    const env: NodeJS.ProcessEnv = {
      CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: '/tmp/antigravity.secret' }),
    };

    const result = await ensureGptProAgentKeySidecar(registry, { filePath, env });

    assert.equal(result.kind, 'replaced');
    assert.equal(env.CAT_CAFE_AGENT_KEY_FILES, JSON.stringify({ antigravity: '/tmp/antigravity.secret' }));
    assert.equal(env.CAT_CAFE_AGENT_KEY_FILE, undefined);
    const verified = await registry.verify((await readFile(filePath, 'utf8')).trim());
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.record.catId, 'gpt-pro');
    assert.equal(verified.record.userId, 'default-user');
  });

  it('issues the sidecar for DEFAULT_OWNER_USER_ID instead of legacy agent user variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-gpt-pro-owner-'));
    tempRoots.push(root);
    const filePath = join(root, 'agent-keys', 'gpt-pro.secret');
    const registry = new AgentKeyRegistry();
    const env: NodeJS.ProcessEnv = {
      DEFAULT_OWNER_USER_ID: 'configured-owner',
      CAT_CAFE_AGENT_KEY_USER_ID: 'legacy-agent-user',
      CAT_CAFE_USER_ID: 'legacy-cloud-user',
    };

    await ensureGptProAgentKeySidecar(registry, { filePath, env });

    const verified = await registry.verify((await readFile(filePath, 'utf8')).trim());
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.record.userId, 'configured-owner');
  });
});
