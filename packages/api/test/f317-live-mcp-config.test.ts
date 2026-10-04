import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildLiveMcpConfig } from '../src/domains/concierge/live/live-mcp-config.js';
import { LiveNativeCredentials } from '../src/domains/concierge/live/live-native-credentials.js';

test('voice-only admission binds its own call but exposes no household MCP servers', async () => {
  const credentials = await LiveNativeCredentials.create({
    userId: 'owner',
    threadId: 'home',
    catId: 'codex-astra',
    callId: 'voice-only',
  });
  try {
    const config = await buildLiveMcpConfig({
      credentials,
      householdToolsEnabled: false,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'owner',
        CAT_CAFE_THREAD_ID: 'home',
        CAT_CAFE_CAT_ID: 'codex-astra',
        CAT_CAFE_INVOCATION_ID: 'voice-only',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      },
    });
    assert.deepEqual(config.mcp_servers, {});
    assert.equal(config['features.shell_tool'], false);
    assert.equal(config['apps._default.enabled'], false);
  } finally {
    await credentials.close();
  }
});

test('household search paths resolve at the repository while source and private files stay denied', async () => {
  const credentials = await LiveNativeCredentials.create({
    userId: 'owner',
    threadId: 'home',
    catId: 'codex-astra',
    callId: 'source-read',
  });
  try {
    const config = await buildLiveMcpConfig({
      credentials,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'owner',
        CAT_CAFE_THREAD_ID: 'home',
        CAT_CAFE_CAT_ID: 'codex-astra',
        CAT_CAFE_INVOCATION_ID: 'source-read',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      },
    });
    const memory = (config.mcp_servers as Record<string, { cwd?: string; env: Record<string, string> }>)[
      'cat-cafe-memory'
    ];
    const source = pathToFileURL(resolve('../mcp-server/dist/tools/file-tools.js')).href;
    const values = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const {handleReadFileSlice}=await import(${JSON.stringify(source)});
      const paths=['docs/features/F317-coactive-companion.md','packages/api/package.json','.cat-cafe/cat-catalog.json'];
      console.log(JSON.stringify(await Promise.all(paths.map(path=>handleReadFileSlice({path,startLine:1,endLine:5})))));
    `,
        ],
        { cwd: memory.cwd ?? process.cwd(), env: { ...process.env, ...memory.env }, encoding: 'utf8' },
      ),
    );
    assert.notEqual(values[0].isError, true, 'a search result must be readable without retrying guessed paths');
    assert.match(values[0].content[0].text, /F317/);
    assert.equal(values[1].isError, true, 'cwd is a coordinate, not authority to read source');
    assert.equal(values[2].isError, true, 'private configuration remains outside the granted roots');
  } finally {
    await credentials.close();
  }
});
