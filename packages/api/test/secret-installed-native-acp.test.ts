import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// Exercise the production supervisor without propagating test-only loaders into the isolated client cwd.
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { protectNativeProviderResult } from '../src/domains/cats/services/agents/invocation/secret-provider-result.js';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../src/domains/cats/services/agents/providers/acp/acp-event-transformer.js';
import { ensureKimiSecretHooks } from '../src/domains/cats/services/agents/providers/kimi-secret-hooks.js';
import { withOpenCodeSecretGuard } from '../src/domains/cats/services/agents/providers/opencode-secret-config.js';
import { startNativeProbeApi } from './helpers/secret-native-api.js';

for (const provider of ['opencode', 'kimi'] as const)
  for (const carrier of ['cli', 'acp'] as const)
    for (const scenario of carrier === 'acp' ? ['clean', 'blocked', 'read', 'exposed'] : ['clean', 'blocked'])
      test(
        `installed ${provider} ${carrier}: native ${scenario}`,
        {
          timeout: 45000,
          skip: spawnSync(provider, ['--version'], { timeout: 5000 }).status !== 0,
        },
        async () => {
          const root = await mkdtemp(join(tmpdir(), `secret-${provider}-`));
          const marker = join(root, 'marker');
          const fake = ['ghp', '_', 'Q'.repeat(36)].join('');
          const resultPath = join(root, 'result.txt');
          await writeFile(resultPath, fake);
          await writeFile(join(root, '.env.local'), 'fixture-private');
          const command =
            scenario === 'read'
              ? `cat '${join(root, '.env.local')}'; touch '${marker}'`
              : scenario === 'exposed'
                ? `cat '${resultPath}'; touch '${marker}'`
                : `printf '%s' '${scenario === 'blocked' ? fake : 'clean'}'; touch '${marker}'`;
          const probe = await startNativeProbeApi((tools) => {
            const tool = tools.find((entry) => /^(?:bash|shell)$/i.test(entry.function?.name ?? ''));
            return tool?.function
              ? { name: tool.function.name, args: { command, description: 'Check native guard' } }
              : undefined;
          });
          const { base, requests, notices } = probe;
          const env = {
            PATH: process.env.PATH ?? '',
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: join(root, '.config'),
            XDG_DATA_HOME: join(root, '.local/share'),
            XDG_CACHE_HOME: join(root, '.cache'),
            NO_COLOR: '1',
            CI: '1',
          };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 35000);
          let output = '';
          let errors = '';
          let acp: AcpClient | undefined;
          try {
            let args: string[];
            let extra: Record<string, string>;
            if (provider === 'kimi') {
              await ensureKimiSecretHooks({ HOME: root, KIMI_CODE_HOME: join(root, '.kimi-code') });
              args = ['--output-format', 'stream-json', '-p', 'Run the supplied native tool once.'];
              extra = {
                KIMI_CODE_HOME: join(root, '.kimi-code'),
                KIMI_MODEL_NAME: 'fixture',
                KIMI_MODEL_API_KEY: 'fixture-local-only',
                KIMI_MODEL_BASE_URL: base,
                KIMI_MODEL_PROVIDER_TYPE: 'openai',
                KIMI_MODEL_CAPABILITIES: 'tool_call',
                KIMI_V2_ENGINE: '1',
              };
            } else {
              const path = join(root, 'opencode.json');
              await writeFile(
                path,
                JSON.stringify(
                  withOpenCodeSecretGuard({
                    model: 'fixture/probe',
                    provider: {
                      fixture: {
                        npm: '@ai-sdk/openai-compatible',
                        options: { baseURL: base, apiKey: 'fixture-local-only' },
                        models: { probe: { name: 'Probe', limit: { context: 65536, output: 8192 } } },
                      },
                    },
                  }),
                ),
              );
              args = [
                'run',
                '--auto',
                '--format',
                'json',
                '--model',
                'fixture/probe',
                'Run the supplied native tool once.',
              ];
              extra = {
                OPENCODE_CONFIG: path,
                CAT_CAFE_GUARD_NODE: process.execPath,
                OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
                OPENCODE_DISABLE_MODELS_FETCH: 'true',
                OPENCODE_DISABLE_SHARE: 'true',
                OPENCODE_DISABLE_AUTOUPDATE: 'true',
              };
            }
            let code: number | null = 0;
            if (carrier === 'acp') {
              acp = new AcpClient({
                command: provider,
                args: ['acp'],
                cwd: root,
                env: { ...env, ...extra },
                inheritParentEnv: false,
              });
              await acp.initialize();
              const session = await acp.newSession(root);
              const result = await acp.promptCollect(session.sessionId, 'Run the supplied native tool once.', {
                timeoutMs: 30000,
              });
              output = JSON.stringify(result);
              const state = createAcpSessionState();
              const guarded: unknown[] = [];
              for (const event of result.events) {
                const transformed = transformAcpEvent(event, provider, {}, state);
                for (const message of Array.isArray(transformed) ? transformed : transformed ? [transformed] : [])
                  if (message.type === 'tool_result')
                    guarded.push(
                      await protectNativeProviderResult(message, {
                        callbackEnv: {
                          CAT_CAFE_API_URL: base.slice(0, -3),
                          CAT_CAFE_INVOCATION_ID: 'current-native-turn',
                          CAT_CAFE_CALLBACK_TOKEN: 'fixture-current-turn',
                        },
                      }),
                    );
              }
              if (scenario === 'exposed') {
                assert.ok(output.includes(fake), 'real native result reached the host consumer');
                assert.ok(!JSON.stringify(guarded).includes(fake));
                assert.equal(notices.length, 1);
                assert.equal(notices[0]?.invocation, 'current-native-turn');
                assert.ok(!notices[0]?.body.includes(fake));
              }
            } else {
              const child = spawn(provider, args, {
                cwd: root,
                env: { ...env, ...extra },
                stdio: ['ignore', 'pipe', 'pipe'],
                signal: controller.signal,
              });
              child.stdout.on('data', (chunk) => {
                output += chunk;
              });
              child.stderr.on('data', (chunk) => {
                errors += chunk;
              });
              child.on('error', () => {});
              code = await new Promise<number | null>((resolve) => child.once('close', resolve));
            }
            assert.equal(controller.signal.aborted, false, `${provider} timed out`);
            assert.equal(code, 0, errors.slice(-2000));
            assert.equal(probe.offered, true, output.slice(-1000));
            assert.equal(existsSync(marker), scenario === 'clean' || scenario === 'exposed');
            if (scenario === 'blocked' || scenario === 'read')
              assert.match(requests.slice(1).join('\n'), /secret_(?:content|hook)_blocked|credential_source_blocked/);
            if (scenario !== 'exposed') assert.equal(notices.length, 0);
          } finally {
            clearTimeout(timer);
            controller.abort();
            await acp?.close();
            await probe.close();
            await rm(root, { recursive: true, force: true });
          }
        },
      );
