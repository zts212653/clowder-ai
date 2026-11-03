import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const laterSource of ['changed', 'unreadable']) {
  test(`Host consumes the admitted shared MCP context when the later source is ${laterSource}`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/shared-mcp-freeze');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const host = join(root, 'host'),
      project = join(root, 'project');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    const keys = [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
      'CAT_CAFE_MCP_TRANSPORT',
      'CAT_CAFE_DEPLOYMENT_ID',
      'CAT_CAFE_DATA_DIR',
      'ALLOWED_WORKSPACE_DIRS',
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const all = catRegistry.getAllConfigs(),
      catId = 'shared-mcp-freeze';
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      mcpSupport: true,
      accountRef: undefined,
      configurationSource: 'native_tool',
    });
    t.after(() => {
      previous.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const capabilities = join(host, '.cat-cafe/capabilities.json');
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-memory',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: process.execPath, args: [] },
        },
      ],
    };
    writeFileSync(capabilities, JSON.stringify(config));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.CAT_CAFE_MCP_TRANSPORT = 'stdio';
    process.env.CAT_CAFE_DEPLOYMENT_ID = 'admitted-deployment';
    process.env.CAT_CAFE_DATA_DIR = join(root, 'admitted-data');
    process.env.ALLOWED_WORKSPACE_DIRS = 'docs';
    let registeredContext, providerOptions;
    const service = {
      async *invoke(_prompt, options) {
        providerOptions = options;
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    };
    const deps = {
      threadStore: { get: () => ({ id: 'thread', projectPath: project, createdBy: 'owner' }) },
      apiUrl: 'http://127.0.0.1:13004',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      registry: {
        create: (...args) => {
          registeredContext = args.at(-1);
          return { invocationId: 'shared-mcp-frozen-invocation', callbackToken: 'fixture-only' };
        },
        verify: async () => ({ ok: false }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => project,
      },
    };
    const executionBinding = await prepareInvocationExecutionBinding(deps, {
      catId,
      threadId: 'thread',
      userId: 'owner',
      service,
    });
    process.env.CAT_CAFE_MCP_TRANSPORT = 'shared';
    process.env.CAT_CAFE_DEPLOYMENT_ID = 'later-deployment';
    process.env.CAT_CAFE_DATA_DIR = join(root, 'later-data');
    process.env.ALLOWED_WORKSPACE_DIRS = 'later-docs';
    writeFileSync(capabilities, laterSource === 'unreadable' ? '{' : JSON.stringify({ ...config, capabilities: [] }));
    const messages = await Array.fromAsync(
      invokeSingleCat(deps, {
        catId,
        userId: 'owner',
        threadId: 'thread',
        prompt: 'isolated task',
        isLastCat: true,
        service,
        executionBinding,
      }),
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.equal(registeredContext.deploymentId, 'admitted-deployment');
    assert.equal(registeredContext.dataDir, join(root, 'admitted-data'));
    assert.equal(registeredContext.workspaceRoot, project);
    assert.deepEqual(registeredContext.allowedWorkspaceDirs, [join(project, 'docs')]);
    assert.deepEqual(registeredContext.families, ['memory']);
    assert.equal(providerOptions.callbackEnv.CAT_CAFE_MCP_TRANSPORT, 'stdio');
    assert.equal(providerOptions.callbackEnv.CAT_CAFE_DATA_DIR, registeredContext.dataDir);
  });
}
