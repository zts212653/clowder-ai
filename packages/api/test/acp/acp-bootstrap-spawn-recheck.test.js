import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';

for (const Client of [AcpClient, AcpHttpStreamClient]) {
  test(
    `${Client.name} verifies the actual plan/environment before spawn and cannot recreate an unverified cwd`,
    { skip: process.platform !== 'win32' },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'acp-spawn-recheck-'));
      const cwd = join(root, 'lost-private-cwd');
      const args = [
        resolve('packages/api/dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js'),
        '--pi-command',
        process.execPath,
      ];
      const sentinel = new Error('native privacy verifier refused');
      let verified = false;
      const client = new Client({
        command: process.execPath,
        args,
        cwd,
        env: { ACP_RECHECK_SENTINEL: 'child' },
        verifyBootstrapCwd(command, actualArgs, env) {
          verified = true;
          assert.equal(command, process.execPath);
          assert.deepEqual(actualArgs, args);
          assert.equal(env.ACP_RECHECK_SENTINEL, 'child');
          assert.equal(env.PWD, cwd);
          assert.equal(existsSync(cwd), false, 'generic mkdir must not bypass private creation');
          throw sentinel;
        },
      });
      try {
        await assert.rejects(client.initialize(), (error) => error === sentinel);
        assert.equal(verified, true);
        assert.equal(existsSync(cwd), false);
      } finally {
        await client.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
