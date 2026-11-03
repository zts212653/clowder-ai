import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';
import { providerProfileAccountSnapshot } from '../../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { compileL0ViaSubprocess } from '../../dist/domains/cats/services/agents/providers/l0-compiler.js';

const [carrier, scenario] = process.argv.slice(2);
assert.ok(['dsh', 'kimi'].includes(carrier));
assert.ok(['frozen', 'missing'].includes(scenario));
const home = await mkdtemp(join(tmpdir(), 'member-frozen-l0-'));
const profile = { id: 'native-fixture', authType: carrier === 'kimi' ? 'oauth' : 'api_key' };
const account = { profile, home, model: 'native-model', accountEnv: {} };
// Native account discovery has separate qualification tests. Keep this boundary
// deterministic while exercising the actual carrier and real L0 compiler child.
mock.module(new URL(`../../dist/config/native-accounts/${carrier}-account.js`, import.meta.url).href, {
  namedExports: { [carrier === 'kimi' ? 'readKimiNativeAccount' : 'readDshNativeAccount']: async () => account },
});
const invokerModule = await import(
  `../../dist/domains/cats/services/agents/providers/acp/${carrier}/${carrier}-member-invocation.js`
);
const invoke = carrier === 'kimi' ? invokerModule.invokeKimiMember : invokerModule.invokeDshMember;
const catId = 'programmatic-native-frozen-member';
const member = { displayName: 'Frozen native', roleDescription: 'captured-native-role', personality: 'precise' };
const frozen = captureFrozenL0Input({
  catId,
  projection: 'scoped-member',
  member,
  model: account.model,
  installRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
});
member.roleDescription = 'mutated-live-native-role';
let captured, rendered, compileError;
try {
  const messages = await Array.fromAsync(
    invoke({
      catId,
      modelSelection: account.model,
      native: {},
      prompt: 'Never sent to a provider',
      compile: async (input) => {
        captured = input;
        try {
          rendered = await compileL0ViaSubprocess(input);
        } catch (error) {
          compileError = error;
        }
        throw new Error('stop_before_native_client');
      },
      options: {
        ...(scenario === 'frozen' ? { frozenL0Input: frozen } : {}),
        workingDirectory: home,
        signal: new AbortController().signal,
        executionAccount: providerProfileAccountSnapshot(carrier === 'kimi' ? 'kimi' : 'acp', profile),
        toolExecutionPolicy: {
          mode: 'plugin_native',
          pluginInstanceId: 'fixture',
          contributionId: 'player',
          memberSession: { sessionId: 'member', generation: 1, executionId: 'execution' },
        },
        pluginNativeLaunch: {
          sandbox: { kind: 'scoped-member', workspaceRoot: home },
          server: {
            name: 'plugin__fixture__player',
            transport: 'stdio',
            command: process.execPath,
            args: [],
            workingDirectory: home,
          },
          assertCurrent() {},
        },
      },
    }),
  );
  assert.ok(captured, 'the native carrier must reach identity compilation');
  assert.equal(captured.requireFrozenInput, true);
  assert.equal(captured.projection, 'scoped-member');
  assert.equal(captured.runtimeModel, account.model);
  if (scenario === 'frozen') {
    assert.equal(captured.frozenInput, frozen);
    assert.equal(compileError, undefined);
    assert.match(rendered, /captured-native-role/);
    assert.doesNotMatch(rendered, /mutated-live-native-role/);
  } else {
    assert.equal(rendered, undefined);
    assert.match(compileError?.message ?? '', /frozen.*required/i);
  }
  assert.equal(messages.at(-1)?.type, 'done');
  assert.ok(messages.some((message) => message.type === 'error'));
} finally {
  await rm(home, { recursive: true, force: true });
}
