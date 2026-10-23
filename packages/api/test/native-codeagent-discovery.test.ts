import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverCodeAgentRuntimes } from '../src/routes/native-codeagent-discovery.js';

test('intranet CodeAgent discovery provides one tool and only the Yanyan role recommendation', () => {
  const probed: string[] = [];
  const runtimes = discoverCodeAgentRuntimes((name) => {
    probed.push(name);
    return name === 'codeagent' ? 'D:/Enterprise/codeagent.exe' : null;
  }, true);
  assert.deepEqual(probed, ['codeagent']);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0]?.id, 'codeagent');
  assert.equal(runtimes[0]?.label, 'CodeAgent');
  assert.equal(runtimes[0]?.harnessId, 'codeagent');
  assert.equal(runtimes[0]?.kind, 'tool');
  assert.deepEqual(runtimes[0]?.roleTemplates, [{ id: 'maine-coon', priority: 100 }]);
  for (const runtime of runtimes) {
    assert.equal(runtime.installed, true);
    assert.equal(runtime.clientId, 'acp');
    assert.equal('roleTemplateId' in runtime, false);
    assert.equal('priority' in runtime, false);
    assert.deepEqual(runtime.acp, {
      command: 'D:/Enterprise/codeagent.exe',
      startupArgs: ['--acp'],
      transport: 'stdio',
    });
  }
});

test('missing CodeAgent stays visible but unavailable and never invents an executable or login status', () => {
  const runtimes = discoverCodeAgentRuntimes(() => null, true);
  assert.equal(runtimes.length, 1);
  for (const runtime of runtimes) {
    assert.equal(runtime.installed, false);
    assert.equal(runtime.acp, undefined);
  }
});
