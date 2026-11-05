import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { verifyAcpBootstrap } from '../../dist/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-context.js';

for (const provider of ['pi', 'dsh']) {
  test(
    `${provider} audited startup initializes and reopens from a private data-volume child without a model call`,
    { skip: process.platform !== 'win32', timeout: 60000 },
    async (t) => {
      const volume = process.env.ACP_BOOTSTRAP_TEST_VOLUME;
      const dsh = process.env.ACP_DSH_AUDITED_ENTRY;
      if (!volume || (provider === 'dsh' && !dsh))
        return t.skip('requires explicit native volume / audited DSH fixtures');
      assert.equal(parse(volume).root, volume);
      assert.notEqual(volume.toLowerCase(), `${process.env.SystemDrive}\\`.toLowerCase());
      const parent = mkdtempSync(join(tmpdir(), 'acp-audited-runtime-'));
      const root = join(volume, `.clowder-acp-1653-test-${randomUUID()}`);
      const env = { NODE_OPTIONS: '', NODE_PATH: '', DSH_HOME: join(parent, 'isolated-dsh-home') };
      const args =
        provider === 'pi'
          ? [
              resolve('packages/api/dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js'),
              '--pi-command',
              join(parent, 'never-launched-pi.exe'),
            ]
          : [dsh, '--profile', 'acp'];
      try {
        const bootstrap = verifyAcpBootstrap(
          {
            projectRoot: parent,
            command: process.execPath,
            args,
            poolKey: { projectPath: parent, providerProfile: provider },
          },
          provider,
          root,
          env,
        );
        assert.equal(bootstrap.isolation, provider === 'pi' ? 'builtin-pi' : 'dsh-0.2.0-rc.2');
        for (let attempt = 0; attempt < 2; attempt++) {
          const client = new AcpClient({
            command: process.execPath,
            args,
            cwd: bootstrap.verifyCwd(),
            env,
            verifyBootstrapCwd: bootstrap.verifyCwd,
          });
          try {
            const result = await client.initialize();
            assert.ok(result.agentInfo?.name);
            assert.equal(client.isCwdIntact, true);
          } finally {
            await client.close();
          }
        }
        assert.equal(existsSync(join(env.DSH_HOME, 'sessions')), false, 'initialize must not create a model session');
      } finally {
        assert.equal(parse(root).dir, volume);
        assert.match(parse(root).base, /^\.clowder-acp-1653-test-[0-9a-f-]{36}$/);
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
}
