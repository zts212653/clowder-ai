import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  ClaudeAgentService,
  resolveClaudeEffortLevel,
} from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import {
  buildCodexReasoningArgs,
  CodexAgentService,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { createClaudeAgentServiceForCanary } from '../dist/domains/cats/services/agents/providers/claude-carrier-factory.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

const base = catRegistry.tryGet('opus').config;
catRegistry.register('native-claude', {
  ...base,
  id: 'native-claude',
  configurationSource: 'native_tool',
  defaultModel: '',
  cli: { command: 'claude', outputFormat: 'stream-json' },
});
catRegistry.register('native-codex', {
  ...base,
  id: 'native-codex',
  clientId: 'openai',
  configurationSource: 'native_tool',
  defaultModel: '',
  cli: { command: 'codex', outputFormat: 'json', carrier: 'exec_json' },
});
ensureFakeCliOnPath('claude');
test('native Claude launch omits model and effort and keeps native auth environment', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ catId: 'native-claude', spawnFn, l0CompilerFn: buildFakeL0Compiler() });
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-native-auth';
  try {
    const pending = collect(service.invoke('fixture prompt'));
    await emitEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await pending;
    const [, _args, options] = spawnFn.mock.calls[0].arguments;
    assert.equal(_args.includes('--model'), false);
    assert.equal(_args.includes('--effort'), false);
    assert.equal(options.env.ANTHROPIC_API_KEY, 'fixture-native-auth');
    assert.equal(_args[_args.indexOf('--setting-sources') + 1], 'project,local,user');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});
test('native Claude preserves explicit SDK carrier selection', () => {
  assert.ok(
    createClaudeAgentServiceForCanary('native-claude', { CAT_CAFE_CLAUDE_CARRIER: 'agent_sdk' }) instanceof
      ClaudeSdkAgentService,
  );
  assert.equal(resolveClaudeEffortLevel('native-claude', '', undefined), '');
});
test('native Codex preserves explicit exec carrier and omits the reasoning default', () => {
  const service = new CodexAgentService({ catId: 'native-codex', carrierMode: 'exec_json' });
  assert.equal(service.carrierMode, 'exec_json');
  assert.deepEqual(buildCodexReasoningArgs(''), []);
});
