import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import {
  type InvocationDeps,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../src/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../src/domains/cats/services/stores/ports/ContextEpochStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentMessage, AgentServiceOptions } from '../src/domains/cats/services/types.js';

for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig('../../cat-template.json'))))
  if (!catRegistry.has(id)) catRegistry.register(id, config);
const catId = createCatId('f322-opencode-workspace');
catRegistry.register(catId, {
  ...catRegistry.tryGet('codex')!.config,
  id: catId,
  clientId: 'opencode',
  defaultModel: 'anthropic/claude-sonnet-4-5',
  mcpSupport: false,
  cli: { command: 'opencode', outputFormat: 'ndjson' },
});

async function run(imported: boolean, workspace: 'same' | 'different' | 'unknown') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f322-oc-workspace-')));
  const priorRoots = process.env.PROJECT_ALLOWED_ROOTS;
  process.env.PROJECT_ALLOWED_ROOTS = [
    root,
    resolve('../..'),
    process.env.CAT_CAFE_WORKSPACE_ROOT,
    process.env.CAT_CAFE_RUNTIME_ROOT,
  ]
    .filter(Boolean)
    .join(delimiter);
  const threads = new ThreadStore();
  const thread = threads.create('u');
  threads.updateProjectPath(thread.id, root);
  const sessions = new SessionChainStore();
  const record = sessions.create({ threadId: thread.id, userId: 'u', catId, cliSessionId: 'ses_original' });
  sessions.update(record.id, {
    ...(workspace === 'unknown' ? {} : { workingDirectory: workspace === 'same' ? root : join(root, 'old-location') }),
    ...(imported
      ? {
          externalImport: {
            cliSessionId: 'ses_original',
            clientId: 'opencode' as const,
            projectPath: root,
            firstPrompt: 'Original task',
            lastActivityAt: 1,
            importedAt: 2,
          },
        }
      : {}),
  });
  const inputs: AgentServiceOptions[] = [];
  const output: AgentMessage[] = [];
  let deletes = 0;
  const deps = {
    registry: {
      create: () => ({ invocationId: 'f322-oc-workspace', callbackToken: 'test' }),
      verify: async () => ({ ok: false }),
    },
    sessionManager: {
      get: async () => 'ses_original',
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {
        deletes++;
      },
      resolveWorkingDirectory: () => root,
    },
    threadStore: threads,
    sessionChainStore: sessions,
    apiUrl: 'http://127.0.0.1:1',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
  } as unknown as InvocationDeps;
  const service = {
    l0CompilerFn: async ({ outPath }: { outPath?: string }) => {
      if (outPath) writeFileSync(outPath, 'Current test identity');
      return 'Current test identity';
    },
    async *invoke(_prompt: string, options?: AgentServiceOptions) {
      assert.ok(options);
      inputs.push(options);
      yield {
        type: 'session_init' as const,
        catId,
        sessionId: options.sessionId ?? 'ses_FRESH',
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId, timestamp: Date.now() };
    },
  };
  try {
    for await (const message of invokeSingleCat(deps, {
      catId,
      threadId: thread.id,
      userId: 'u',
      prompt: 'Continue the original task',
      service,
      capacitySnapshot: {
        capacity: {
          windowTokens: 0,
          inputCeilingTokens: 0,
          source: 'unresolved',
          provenance: 'test',
          actionable: false,
        },
        capability: {
          provider: 'test',
          carrier: 'test',
          reportsRuntimeWindow: false,
          authoritativeUsage: false,
          nativeWindowControl: false,
          nativeCompressionControl: false,
          observesCompression: false,
          reason: 'test',
        },
      },
    }))
      output.push(message);
    return {
      inputs,
      output,
      deletes,
      originalId: sessions.get(record.id)?.cliSessionId,
      fresh: sessions.getByCliSessionId('ses_FRESH'),
    };
  } finally {
    if (priorRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
    else process.env.PROJECT_ALLOWED_ROOTS = priorRoots;
    rmSync(root, { recursive: true, force: true });
  }
}

test('an imported OpenCode session resumes its original native ID in the original workspace', async () => {
  const result = await run(true, 'same');
  assert.equal(result.inputs.length, 1, JSON.stringify(result.output.filter((m) => m.type === 'error')));
  assert.equal(result.inputs[0].sessionId, 'ses_original');
  assert.equal(result.inputs[0].requireExactResume, true);
});
for (const workspace of ['different', 'unknown'] as const) {
  test(`an imported OpenCode session with ${workspace} workspace fails before fresh-start or binding deletion`, async () => {
    const result = await run(true, workspace);
    assert.equal(result.inputs.length, 0);
    assert.equal(result.deletes, 0);
    assert.equal(result.originalId, 'ses_original');
    assert.equal(result.fresh, null);
    assert.ok(result.output.some((m) => m.type === 'error' && m.error?.includes('imported OpenCode session')));
  });
  test(`ordinary OpenCode recovery still starts fresh for a ${workspace} workspace`, async () => {
    const result = await run(false, workspace);
    assert.equal(result.inputs.length, 1, JSON.stringify(result.output.filter((m) => m.type === 'error')));
    assert.equal(result.inputs[0].sessionId, undefined);
    assert.equal(result.deletes, 1);
  });
}
