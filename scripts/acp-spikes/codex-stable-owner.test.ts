import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stableOwner } from './codex-stable-owner.mjs';

test('W4.P test owner rejects extra input, metadata, MCP and repeated prompts before dispatch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-owner-policy-'));
  const bundle = join(cwd, 'fake-bridge.mjs');
  await writeFile(
    bundle,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line);
const result=request.method==='session/new'?{sessionId:'test-session'}:{};
console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});`,
  );
  const mcpServers = [{ name: 'fixture', command: 'fixed-test-only-command' }];
  const owner = await stableOwner({
    bundle,
    cwd,
    env: {},
    syntheticPrompt: 'synthetic',
    allowedSteer: 'synthetic steer',
    mcpServers,
  });
  try {
    const init = { protocolVersion: 1, clientInfo: { name: 'fixed' }, clientCapabilities: {} };
    await owner.request('initialize', init);
    await assert.rejects(owner.request('initialize', { ...init, clientCapabilities: { fs: {} } }), /409/);
    await assert.rejects(owner.request('session/new', { cwd, mcpServers: [{ name: 'different' }] }), /403/);
    await owner.request('session/new', { cwd, mcpServers });
    const prompt = { sessionId: 'test-session', prompt: [{ type: 'text', text: 'synthetic' }] };
    const before = owner.frames.filter((frame) => frame.direction === 'bridge-out').length;
    await assert.rejects(owner.request('session/prompt', { ...prompt, _meta: { extra: true } }), /403/);
    await assert.rejects(
      owner.request('session/prompt', { ...prompt, prompt: [...prompt.prompt, { type: 'text', text: 'extra' }] }),
      /403/,
    );
    await assert.rejects(
      owner.request('_clowder/v1/control', {
        action: 'steer',
        sessionId: 'test-session',
        prompt: [
          { type: 'text', text: 'synthetic steer' },
          { type: 'text', text: 'extra' },
        ],
      }),
      /403/,
    );
    assert.equal(owner.frames.filter((frame) => frame.direction === 'bridge-out').length, before);
    await owner.request('session/prompt', prompt);
    await assert.rejects(owner.request('session/prompt', prompt), /403/);
  } finally {
    const one = owner.close();
    const two = owner.close();
    assert.equal(one, two, 'Budget timer and finally must share owner teardown');
    await Promise.all([one, two]);
  }
});
