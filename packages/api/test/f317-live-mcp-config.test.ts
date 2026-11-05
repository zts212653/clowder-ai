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
    assert.equal(config['features.apply_patch_freeform'], false);
    assert.equal(config['apps._default.enabled'], false);
  } finally {
    await credentials.close();
  }
});

test('Live approves only the admitted page inspection while execution still requires owner consent', async () => {
  const credentials = await LiveNativeCredentials.create({
    userId: 'owner',
    threadId: 'home',
    catId: 'codex61-sol',
    callId: 'page-approval',
  });
  try {
    const config = await buildLiveMcpConfig({
      credentials,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      screenServer: { enabled: true, command: process.execPath, args: [], env: {} },
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'owner',
        CAT_CAFE_THREAD_ID: 'home',
        CAT_CAFE_CAT_ID: 'codex61-sol',
        CAT_CAFE_INVOCATION_ID: 'page-approval',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      },
    });
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
    assert.deepEqual(servers['cat-cafe-collab'].tools, {
      cat_cafe_page_action_inspect: { approval_mode: 'approve' },
      cat_cafe_home_action: { approval_mode: 'approve' },
      cat_cafe_admit_entrusted_work: { approval_mode: 'approve' },
      cat_cafe_read_entrusted_work: { approval_mode: 'approve' },
      cat_cafe_update_entrusted_work: { approval_mode: 'approve' },
      cat_cafe_update_task: { approval_mode: 'approve' },
      cat_cafe_close_entrusted_work: { approval_mode: 'approve' },
    });
    assert.deepEqual(
      servers['cat-cafe-collab'].disabled_tools,
      ['sources', 'start', 'attach', 'status', 'stop'].map((name) => `cat_cafe_meeting_${name}`),
    );
    for (const [name, server] of Object.entries(servers)) {
      assert.equal(server.default_tools_approval_mode, undefined, `${name} must not approve its whole surface`);
      if (name !== 'cat-cafe-collab') assert.equal(server.tools, undefined, `${name} gets no new approval`);
    }
    assert.equal(config['features.shell_tool'], false);
    assert.equal(config['features.apply_patch_freeform'], false);
    assert.equal(config['apps._default.enabled'], false);
    assert.equal(servers['cat-cafe-collab'].required, true);
  } finally {
    await credentials.close();
  }
});

test('explicit meeting admission without household reads exposes exactly the five meeting tools', async () => {
  const credentials = await LiveNativeCredentials.create({
    userId: 'owner',
    threadId: 'home',
    catId: 'codex61-sol',
    callId: 'meeting-only',
  });
  try {
    const config = await buildLiveMcpConfig({
      credentials,
      householdToolsEnabled: false,
      meetingToolsEnabled: true,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'owner',
        CAT_CAFE_THREAD_ID: 'home',
        CAT_CAFE_CAT_ID: 'codex61-sol',
        CAT_CAFE_INVOCATION_ID: 'meeting-only',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      },
    });
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(servers), ['cat-cafe-collab']);
    const names = ['sources', 'start', 'attach', 'status', 'stop'].map((name) => `cat_cafe_meeting_${name}`);
    assert.deepEqual(servers['cat-cafe-collab'].enabled_tools, names);
    assert.deepEqual(Object.keys(servers['cat-cafe-collab'].tools as object), names);
    assert.equal(servers['cat-cafe-collab'].default_tools_approval_mode, undefined);
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
