import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getCallbackConfig } from '../src/tools/callback-tools.js';
import { handleReadFileSlice } from '../src/tools/file-tools.js';
import { resolveInvocationEnv, withInvocationCredentials } from '../src/tools/invocation-auth.js';
import { getDefaultConfig } from '../src/utils/path-validator.js';

test('shared local readers use only the admitted workspace and data roots across concurrent owners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-mcp-context-'));
  try {
    const run = (owner: string) => {
      const workspaceRoot = join(root, owner);
      const dataDir = join(root, `${owner}-data`);
      mkdirSync(workspaceRoot);
      mkdirSync(dataDir);
      writeFileSync(join(workspaceRoot, 'document.txt'), `owned by ${owner}`);
      const scope = {
        invocationId: `inv-${owner}`,
        callbackToken: `fixture-${owner}`,
        apiUrl: 'http://127.0.0.1:1',
        catId: owner,
        threadId: `thread-${owner}`,
        userId: `user-${owner}`,
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot,
          dataDir,
          allowedWorkspaceDirs: [workspaceRoot],
          capabilityRoot: workspaceRoot,
          families: ['memory'],
        },
      };
      return withInvocationCredentials(scope, async () => {
        await Promise.resolve();
        assert.deepEqual(getDefaultConfig(), { catCafeDir: dataDir, allowedDirs: [dataDir, workspaceRoot] });
        const result = await handleReadFileSlice({ path: 'document.txt', startLine: 1 });
        assert.equal(result.isError, undefined);
        assert.ok(JSON.stringify(result).includes(`owned by ${owner}`));
        const other = owner === 'one' ? 'two' : 'one';
        const denied = await handleReadFileSlice({ path: join(root, other, 'document.txt'), startLine: 1 });
        assert.equal(denied.isError, true);
      });
    };
    await Promise.all([run('one'), run('two')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared invocation identity cannot fill missing fields from ambient host authority', () => {
  const saved = process.env.CAT_CAFE_CAT_ID;
  process.env.CAT_CAFE_CAT_ID = 'host-cat';
  try {
    withInvocationCredentials(
      { invocationId: 'fixture', callbackToken: 'fixture', sharedContext: {} } as Parameters<
        typeof withInvocationCredentials
      >[0],
      () => {
        assert.throws(() => resolveInvocationEnv('CAT_CAFE_CAT_ID'), /required/);
        assert.throws(getDefaultConfig, /context|workspace|root/i);
      },
    );
  } finally {
    if (saved === undefined) delete process.env.CAT_CAFE_CAT_ID;
    else process.env.CAT_CAFE_CAT_ID = saved;
  }
});

test('a missing shared callback destination cannot use the Host API URL', () => {
  const saved = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:9999';
  try {
    withInvocationCredentials(
      {
        invocationId: 'fixture',
        callbackToken: 'fixture',
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot: '/fixture',
          dataDir: '/fixture/data',
          allowedWorkspaceDirs: ['/fixture'],
          capabilityRoot: '/fixture',
          families: ['memory'],
        },
      },
      () => {
        assert.throws(getCallbackConfig, /API|destination|context/i);
      },
    );
  } finally {
    if (saved === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = saved;
  }
});
