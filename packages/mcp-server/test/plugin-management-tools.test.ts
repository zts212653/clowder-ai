import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  createPluginManagementHandlers,
  createPluginManagerHttpClient,
  pluginManagementTools,
} from '../src/tools/plugin-management-tools.js';

const EXPECTED_NAMES = [
  'plugin_call',
  'plugin_get',
  'plugin_install',
  'plugin_list',
  'plugin_list_tools',
  'plugin_search',
  'plugin_set_enabled',
  'plugin_uninstall',
] as const;

describe('F202 Agent plugin management surface', () => {
  it('publishes six management tools plus governed contribution discovery/invocation', () => {
    assert.deepEqual(pluginManagementTools.map((tool) => tool.name).sort(), [...EXPECTED_NAMES]);
    assert.equal(
      pluginManagementTools.some((tool) => /update|repair/.test(tool.name)),
      false,
    );
  });

  it('gives every tool a complete routing and side-effect description', () => {
    for (const tool of pluginManagementTools) {
      assert.match(tool.description, /Use (?:only )?when/i, `${tool.name} must state when to use it`);
      assert.match(tool.description, /NOT for:/, `${tool.name} must exclude adjacent operations`);
      assert.match(
        tool.description,
        /Output(?:\/side effect)?:/,
        `${tool.name} must state its output and side effects`,
      );
    }
  });

  it('derives read/write/destructive annotations and profile exposure from governance', () => {
    const byName = new Map(pluginManagementTools.map((tool) => [tool.name, tool]));

    for (const name of ['plugin_list', 'plugin_search', 'plugin_get', 'plugin_list_tools']) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} must exist`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      assert.deepEqual(tool.policy.runtimeProfiles, ['full', 'readonly']);
    }

    for (const name of ['plugin_install', 'plugin_set_enabled', 'plugin_call']) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} must exist`);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
    }

    assert.deepEqual(byName.get('plugin_call')?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });

    const uninstall = byName.get('plugin_uninstall');
    assert.ok(uninstall);
    assert.deepEqual(uninstall.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(uninstall.policy.runtimeProfiles, ['full']);

    for (const tool of pluginManagementTools) {
      assert.equal(
        tool.policy.runtimeProfiles.some((profile) => profile.startsWith('desktop:')),
        false,
      );
    }
  });

  it('keeps every public input closed and requires revision fences', () => {
    const byName = new Map(pluginManagementTools.map((tool) => [tool.name, tool]));
    for (const tool of pluginManagementTools) {
      const schema = z.object(tool.inputSchema as z.ZodRawShape).strict();
      assert.equal(schema.safeParse({ unexpected: true }).success, false, `${tool.name} must reject extra fields`);
    }

    const setEnabledTool = byName.get('plugin_set_enabled');
    assert.ok(setEnabledTool);
    const setEnabled = z.object(setEnabledTool.inputSchema as z.ZodRawShape).strict();
    assert.equal(setEnabled.safeParse({ pluginId: 'official.video', enabled: true }).success, false);
    assert.equal(
      setEnabled.safeParse({ pluginId: 'official.video', enabled: true, expectedRevision: 4 }).success,
      true,
    );

    const uninstallTool = byName.get('plugin_uninstall');
    assert.ok(uninstallTool);
    const uninstall = z.object(uninstallTool.inputSchema as z.ZodRawShape).strict();
    assert.equal(uninstall.safeParse({ pluginId: 'official.video' }).success, false);
    assert.equal(uninstall.safeParse({ pluginId: 'official.video', expectedRevision: 5 }).success, true);

    const pluginCallTool = byName.get('plugin_call');
    assert.ok(pluginCallTool);
    const pluginCall = z.object(pluginCallTool.inputSchema as z.ZodRawShape).strict();
    assert.equal(
      pluginCall.safeParse({
        pluginId: 'official.video',
        contributionId: 'video-analysis-toolset',
        toolName: 'video_analysis',
      }).success,
      false,
    );
    assert.equal(
      pluginCall.safeParse({
        pluginId: 'official.video',
        contributionId: 'video-analysis-toolset',
        toolName: 'video_analysis',
        arguments: { videoUrl: 'https://media.example/video.mp4' },
      }).success,
      true,
    );
  });

  it('delegates management and contribution operations to one injected Host client contract', async () => {
    const calls: unknown[][] = [];
    const client = {
      list: async () => {
        calls.push(['list']);
        return { plugins: [] };
      },
      search: async (query: string) => {
        calls.push(['search', query]);
        return { plugins: [] };
      },
      get: async (pluginId: string) => {
        calls.push(['get', pluginId]);
        return { plugin: { pluginId } };
      },
      listTools: async (pluginId: string) => {
        calls.push(['list-tools', pluginId]);
        return { pluginId, tools: [] };
      },
      call: async (pluginId: string, contributionId: string, toolName: string, args: unknown) => {
        calls.push(['call', pluginId, contributionId, toolName, args]);
        return { content: [] };
      },
      install: async (request: unknown) => {
        calls.push(['install', request]);
        return { pluginId: 'official.video' };
      },
      setEnabled: async (pluginId: string, request: unknown) => {
        calls.push(['set-enabled', pluginId, request]);
        return { pluginId };
      },
      uninstall: async (pluginId: string, request: unknown) => {
        calls.push(['uninstall', pluginId, request]);
        return { pluginId };
      },
    };
    const handlers = createPluginManagementHandlers(client);
    const digest = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;

    await handlers.list({});
    await handlers.search({ query: 'video' });
    await handlers.get({ pluginId: 'official.video' });
    await handlers.listTools({ pluginId: 'official.video' });
    await handlers.call({
      pluginId: 'official.video',
      contributionId: 'video-analysis-toolset',
      toolName: 'video_analysis',
      arguments: { videoUrl: 'https://media.example/video.mp4' },
    });
    await handlers.install({
      request: {
        source: { kind: 'catalog', catalogId: 'video' },
        expectedVersion: '1.0.0',
        expectedDigest: digest,
      },
    });
    await handlers.setEnabled({ pluginId: 'official.video', enabled: true, expectedRevision: 4 });
    await handlers.uninstall({ pluginId: 'official.video', expectedRevision: 5 });

    assert.deepEqual(calls, [
      ['list'],
      ['search', 'video'],
      ['get', 'official.video'],
      ['list-tools', 'official.video'],
      [
        'call',
        'official.video',
        'video-analysis-toolset',
        'video_analysis',
        { videoUrl: 'https://media.example/video.mp4' },
      ],
      [
        'install',
        {
          source: { kind: 'catalog', catalogId: 'video' },
          expectedVersion: '1.0.0',
          expectedDigest: digest,
        },
      ],
      ['set-enabled', 'official.video', { enabled: true, expectedRevision: 4 }],
      ['uninstall', 'official.video', { expectedRevision: 5 }],
    ]);
  });

  it('HTTP client uses canonical REST paths and verified callback headers only', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createPluginManagerHttpClient({
      resolveAuth: () => ({
        apiUrl: 'http://127.0.0.1:3004',
        headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'secret' },
      }),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true }), {
          status: init.method === 'POST' && String(url).endsWith('/install') ? 201 : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.list();
    await client.search('video & audio');
    await client.get('official.video');
    await client.listTools('official.video');
    await client.call('official.video', 'video-analysis-toolset', 'video_analysis', {
      videoUrl: 'https://media.example/video.mp4',
    });
    await client.install({ source: { kind: 'local-directory', path: '/tmp/plugin' } });
    await client.setEnabled('official.video', { enabled: true, expectedRevision: 2 });
    await client.uninstall('official.video', { expectedRevision: 3 });

    assert.deepEqual(
      requests.map(({ url, init }) => [url, init.method ?? 'GET']),
      [
        ['http://127.0.0.1:3004/api/plugin-manager/plugins', 'GET'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/search?q=video+%26+audio', 'GET'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/official.video', 'GET'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/official.video/contributions/tools', 'GET'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/official.video/contributions/call', 'POST'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/install', 'POST'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/official.video/set-enabled', 'POST'],
        ['http://127.0.0.1:3004/api/plugin-manager/plugins/official.video/uninstall', 'POST'],
      ],
    );
    for (const { init } of requests) {
      assert.deepEqual(init.headers, {
        'x-invocation-id': 'inv-1',
        'x-callback-token': 'secret',
        origin: 'http://127.0.0.1:3004',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      });
      assert.equal(Object.keys(init.headers as Record<string, string>).includes('x-cat-cafe-user'), false);
    }
  });

  it('fails closed when callback authority is absent or the Manager rejects a fence', async () => {
    const unauthenticated = createPluginManagerHttpClient({
      resolveAuth: () => null,
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    await assert.rejects(() => unauthenticated.list(), /callback.*not configured/i);

    const conflicted = createPluginManagerHttpClient({
      resolveAuth: () => ({ apiUrl: 'http://127.0.0.1:3004', headers: { 'x-invocation-id': 'inv' } }),
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'STALE_REVISION', error: 'stale' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await assert.rejects(
      () => conflicted.setEnabled('official.video', { enabled: false, expectedRevision: 1 }),
      /409.*STALE_REVISION/i,
    );
  });
});
