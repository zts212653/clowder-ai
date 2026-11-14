import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { codexConfigObjectFromArgs } from '../dist/domains/cats/services/agents/providers/codex-config-overrides.js';
import { watcherNativePort } from '../dist/domains/concierge/watcher/watcher-native-run.js';
import { nativeWatcherAvailable } from './helpers/watcher-native-fixture.js';

test(
  'the actual CLI accepts the watcher proxy for a builtin OpenAI account without starting a turn',
  {
    timeout: 15000,
    skip: !nativeWatcherAvailable,
  },
  async () => {
    const text = await readFile(
      new URL('../src/domains/cats/services/agents/providers/CodexAgentService.ts', import.meta.url),
      'utf8',
    );
    const source = ts.createSourceFile('CodexAgentService.ts', text, ts.ScriptTarget.Latest, true);
    const names = ['oauthTransport', 'builtinOpenaiProviderArgs', 'openaiHttpsProviderArgs', 'providerArgs'];
    const declarations = new Map();
    const walk = (node) => {
      if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source)))
        declarations.set(node.name.getText(source), node.getText(source));
      ts.forEachChild(node, walk);
    };
    walk(source);
    assert.equal(declarations.size, names.length);
    const select = (watcher, nativeAuthentication = false) =>
      vm.runInNewContext(
        ts.transpileModule(`${names.map((name) => `const ${declarations.get(name)};`).join('\n')} providerArgs;`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
          watcher,
          launchPolicy: { oauthTransport: 'builtin' },
          nativeAuthentication,
          customBaseUrl: undefined,
          customProvider: false,
          apiSharedConversations: false,
          customProviderArgs: [],
          authMode: 'oauth',
        },
      );
    const initial = codexConfigObjectFromArgs(select(true));
    assert.equal(
      codexConfigObjectFromArgs(select(true, true)).model_provider,
      initial.model_provider,
      'an explicitly selected OAuth account also uses the owned provider for native-config members',
    );
    assert.equal(
      codexConfigObjectFromArgs(select(false)).model_provider,
      'openai',
      'ordinary OAuth keeps builtin transport',
    );
    assert.notEqual(initial.model_provider, 'openai', 'select a non-reserved provider before the private CLI starts');
    const root = await mkdtemp(join(tmpdir(), 'watcher-builtin-provider-'));
    const controller = new AbortController();
    const run = { state: {}, session: {} };
    const port = watcherNativePort({
      run,
      owners: {},
      bridge: { tools: [] },
      surface: { config: {} },
      instructions: '',
      signal: controller.signal,
      accepted: Promise.resolve(),
      acceptToolCalls() {},
      recorder: {},
    });
    try {
      const config = await port.configureProvider({ config: initial, account: { type: 'chatgpt' }, transportEnv: {} });
      assert.equal(config.model_provider, initial.model_provider, 'never switch provider identity after CLI startup');
      const providerId = config.model_provider;
      const args = ['app-server', '-c', `model_provider=${JSON.stringify(providerId)}`];
      for (const [key, value] of Object.entries(config.model_providers[providerId]))
        args.push('-c', `model_providers.${providerId}.${key}=${JSON.stringify(value)}`);
      const result = await new Promise((resolve, reject) => {
        const child = spawn('codex', args, {
          env: { ...process.env, CODEX_HOME: root },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('CLI initialize timed out'));
        }, 8000);
        child.on('error', reject);
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        child.stdout.on('data', (data) => {
          stdout += data;
          if (stdout.includes('"id":1') || stdout.includes('"id": 1')) child.kill('SIGTERM');
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve({ stdout, stderr });
        });
        child.stdin.write(
          JSON.stringify({
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'watcher-init-only', version: '1' } },
          }) + '\n',
        );
      });
      assert.match(result.stdout, /"result"/, result.stderr);
      assert.doesNotMatch(result.stderr, /reserved built-in provider/);
    } finally {
      controller.abort();
      await run.boundary?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
