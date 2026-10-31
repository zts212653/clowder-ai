import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CodexAgentService,
  codexConfigObjectFromArgs,
  stripReservedCodexSystemConfigs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const configSpellings = [
  (value) => ['--config', value],
  (value) => [`--config=${value}`],
  (value) => ['-c', value],
  (value) => [`-c${value}`],
  (value) => [`-c=${value}`],
];
const unsafeOverrides = [
  'apps._default.default_tools_approval_mode="approve"',
  'apps._default={default_tools_approval_mode="approve"}',
  'apps={_default={default_tools_approval_mode="approve"}}',
  'apps.connector_openai_pages.default_tools_approval_mode="approve"',
  'apps.connector_openai_pages={default_tools_approval_mode="approve"}',
  'apps.connector_openai_pages.tools={write_page={approval_mode="approve"}}',
  'apps.connector_openai_pages.tools.write_page={approval_mode="approve"}',
  'apps.connector_openai_pages.tools.write_page.approval_mode="approve"',
  'apps.connector_openai_pages.links={account={default_tools_approval_mode="approve"}}',
  'apps.connector_openai_pages.links.account={default_tools_approval_mode="approve"}',
  'apps.connector_openai_pages.links.account.default_tools_approval_mode="approve"',
];

async function launch(carrier, cliConfigArgs, sessionId) {
  let captured;
  const capture = async (options) => {
    captured = options;
    throw new Error('fixture-stop-after-launch');
  };
  const service = new CodexAgentService({
    catId: 'codex61-sol',
    model: 'gpt-6.1-sol',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    ...(carrier === 'pooled' ? { appServerHostPool: { createSession: capture } } : {}),
    carrierMode: carrier === 'exec' ? 'exec_json' : 'app_server',
    spawnFn: (_command, args) => {
      captured = { args };
      const proc = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        pid: 12345,
        exitCode: null,
        kill() {},
      });
      setImmediate(() => {
        proc.stdout.end(
          `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
        );
        proc.emit('exit', 0);
        proc.emit('close', 0);
      });
      return proc;
    },
  });
  for await (const _event of service.invoke('approval probe', {
    cliConfigArgs,
    ...(sessionId ? { sessionId } : {}),
    ...(carrier === 'direct' ? { agentCarrierSessionFactory: capture } : {}),
  })) {
  }
  assert.ok(captured, 'the final native launch must be reached');
  return captured.args;
}

for (const [index, spelling] of configSpellings.entries()) {
  test(`raw Apps approval selectors and parent tables are reserved (CLI spelling ${index})`, () => {
    for (const value of unsafeOverrides) {
      assert.deepEqual(stripReservedCodexSystemConfigs(spelling(value), 'codex61-sol'), [], value);
    }
    const ordinaryPreferences = [
      'features.apps=true',
      'apps._default.enabled=false',
      'apps.connector_openai_pages.enabled=true',
      'apps.connector_openai_pages.tools.read_page.enabled=true',
    ].flatMap(spelling);
    assert.deepEqual(stripReservedCodexSystemConfigs(ordinaryPreferences, 'codex61-sol'), ordinaryPreferences);
  });
  for (const [carrier, sessionId] of [
    ['exec', undefined],
    ['exec', 'fixture-resume'],
    ['direct', undefined],
    ['pooled', undefined],
  ]) {
    test(`Apps writes remain gated on ${carrier}${sessionId ? ' resume' : ''} (CLI spelling ${index})`, async () => {
      const args = await launch(
        carrier,
        ['--config', 'features.apps=true', ...unsafeOverrides.flatMap(spelling)],
        sessionId,
      );
      const config = codexConfigObjectFromArgs(args);
      assert.equal(config.apps?._default?.default_tools_approval_mode, 'writes');
      assert.equal(config.apps?.connector_openai_pages, undefined, 'raw per-app approvals cannot supersede defaults');
      assert.equal(args.filter((arg) => arg.includes('default_tools_approval_mode="writes"')).length, 1);
      assert.equal(
        args.some((arg) => arg.startsWith('apps.') && arg.includes('"approve"')),
        false,
      );
      assert.equal(config.features?.apps, true, 'member Apps enablement remains native');
      assert.equal(config.features?.plugins, false);
    });
  }
}
