import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReadRef } from '@cat-cafe/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMemoryToolset, type ToolsetEnv } from '../src/server-toolsets.js';
import { withInvocationCredentials } from '../src/tools/invocation-auth.js';

test('registered runtime profiles preserve original branch qualifications, including a native watcher', async () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), 'read-profile-matrix-'));
  const path = join(directory, 'original.md');
  writeFileSync(path, 'Original file scope.');
  delete process.env.CAT_CAFE_DESKTOP_MODE;
  process.env.ALLOWED_WORKSPACE_DIRS = directory;
  const refs: ReadRef[] = [
    { kind: 'message', messageId: 'original', threadId: 'thread' },
    { kind: 'matter', matterId: 'matter', expectedRevision: 1 },
    { kind: 'profile', layer: 'corpus' },
    { kind: 'cue', handle: 'scoped' },
    { kind: 'file', path, startLine: 1 },
  ];
  let callbacks = 0;
  globalThis.fetch = async (url) => {
    callbacks++;
    const route = new URL(String(url)).pathname;
    const body = route.endsWith('/profile')
      ? { revision: `sha256:${'a'.repeat(64)}`, content: 'Approved current view.' }
      : route.endsWith('/get-message')
        ? { message: { id: 'original', threadId: 'thread', content: 'Original words.', contentRevision: 'v1' } }
        : route.endsWith('/drill')
          ? { status: 'ok', source: { revision: 'v1' }, payload: { summary: 'Cat summary.' } }
          : { matter: { matterId: 'matter', revision: 1 }, entries: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const profiles: Array<{ name: string; env: ToolsetEnv; allowed: ReadRef['kind'][] }> = [
    { name: 'full', env: {}, allowed: ['message', 'matter', 'profile', 'cue', 'file'] },
    { name: 'readonly', env: { readonly: true }, allowed: ['file'] },
    {
      name: 'readonly-agent',
      env: { readonly: true, hasAgentKey: true, agentKeyUnion: true },
      allowed: ['file', 'message', 'profile'],
    },
    { name: 'fable', env: { desktopMode: 'fable-phase0' }, allowed: ['message', 'profile'] },
    { name: 'cloud', env: { desktopMode: 'cloud-pro-phase0' }, allowed: ['message', 'profile'] },
    { name: 'live', env: { desktopMode: 'live-companion' }, allowed: ['message', 'profile', 'file'] },
    {
      name: 'watcher',
      env: { watcher: true, allowedToolNames: ['cat_cafe_read_memory'] },
      allowed: ['message', 'profile', 'matter'],
    },
  ];
  try {
    for (const profile of profiles) {
      const server = new McpServer({ name: 'read-matrix', version: '1' });
      registerMemoryToolset(server, profile.env);
      const client = new Client({ name: 'reader', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        for (const ref of refs) {
          const before = callbacks;
          const result = await withInvocationCredentials(
            {
              invocationId: 'test',
              callbackToken: 'test-token',
              apiUrl: 'http://fixture',
              catId: 'codex61-sol',
              userId: 'owner',
              threadId: 'thread',
              ...(profile.env.watcher
                ? { watcherAdmission: { callId: `read-${ref.kind}`, toolName: 'cat_cafe_read_memory' } }
                : {}),
              authorizeTool: async (name) =>
                assert.equal(name, 'cat_cafe_read_memory', 'local readers reauthorize the actual registered door'),
            },
            () => client.callTool({ name: 'cat_cafe_read_memory', arguments: { ref } }),
          );
          const text = (result.content as Array<{ text: string }>)[0]!.text;
          const body = JSON.parse(text);
          const allowed = profile.allowed.includes(ref.kind);
          assert.equal(body.status, allowed ? 'ok' : 'not_available', `${profile.name} × ${ref.kind}: ${text}`);
          if (!allowed) {
            assert.equal(body.data, undefined);
            assert.equal(callbacks, before);
          } else assert.equal(callbacks - before, ref.kind === 'file' ? 0 : 1, 'no extra callback to resolve a ref');
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  }
});
