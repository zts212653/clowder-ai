import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { qualificationSpawnDeps, runNativeQueryBatch } from '../../dist/domains/memory/message-query-native.js';
import {
  contentRevision,
  parseQualification,
  qualificationBatch,
} from '../../dist/domains/memory/message-query-protocol.js';
import { privateMessageSearchTrace } from '../../dist/domains/memory/message-search-trace.js';
import { ensureFakeCliOnPath } from '../helpers/fake-cli-path.js';

ensureFakeCliOnPath('claude');
const model = 'claude-haiku-5-5';
const fullL0 = 'FULL-L0-CANARY: keep every original instruction.';

async function exercise(t, failed = false) {
  const root = mkdtempSync(join(tmpdir(), 'qualification-native-'));
  const release = join(root, 'exit');
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  });
  const originalGet = catRegistry.tryGet.bind(catRegistry);
  t.mock.method(catRegistry, 'tryGet', (id) =>
    id === 'haiku55'
      ? { config: { id, clientId: 'anthropic', defaultModel: model, accountRef: 'claude' } }
      : originalGet(id),
  );
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.method(ClaudeAgentService.prototype, 'compileL0ToTempFile', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qualification-l0-')), 'system-prompt-l0.md');
    writeFileSync(path, fullL0);
    return path;
  });
  const actualSpawn = qualificationSpawnDeps.spawnFn;
  let spawned = 0;
  t.mock.method(qualificationSpawnDeps, 'spawnFn', (_command, args, options) => {
    spawned++;
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('--permission-mode'), 'dontAsk');
    assert.equal(at('--effort'), 'low');
    assert.equal(at('--model'), model);
    assert.equal(at('--tools'), '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--safe-mode'));
    assert.equal(options.env.CLAUDE_CODE_SAFE_MODE, '1');
    assert.equal(readFileSync(at('--system-prompt-file'), 'utf8'), fullL0);
    // Only this owned fixture is spawned. The actual carrier, final launch
    // adapter, OAuth resolver and process-supervisor/exit path run unchanged.
    const script = `const fs=require('node:fs'); let input='';
      process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{
        const b=JSON.parse(input), emit=x=>console.log(JSON.stringify(x));
        const text=JSON.stringify({requestId:b.requestId,rows:b.rows.map(r=>[r.id,'rejected',null])});
        emit({type:'system',subtype:'init',model:${JSON.stringify(model)},tools:[],mcp_servers:[]});
        emit({type:'stream_event',event:{type:'message_start',message:{model:${JSON.stringify(model)}}}});
        emit({type:'assistant',message:{model:${JSON.stringify(model)},content:[{type:'text',text}],
          usage:{output_tokens:1200,output_tokens_details:{thinking_tokens:1080,thinking:'PRIVATE-THINKING'}}}});
        emit({type:'result',subtype:${JSON.stringify(failed ? 'error_during_execution' : 'success')},
          is_error:${failed},result:text,usage:{output_tokens:1200},duration_ms:10,total_cost_usd:0});
        const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(wait);process.exit(0)}},10);
      });`;
    return actualSpawn(process.execPath, ['-e', script], options);
  });
  const batch = qualificationBatch('document recovery', [
    {
      threadId: 'private-source',
      messageId: 'private-message',
      content: 'a different subject',
      contentRevision: contentRevision('a different subject'),
    },
  ]);
  const traces = [];
  let usageSeen;
  const usage = new Promise((resolve) => {
    usageSeen = resolve;
  });
  let settled = false;
  const pending = runNativeQueryBatch(batch, {
    userId: 'owner',
    signal: controller.signal,
    deadlineAt: Date.now() + 15000,
    onTrace: (event) => {
      traces.push(privateMessageSearchTrace(event));
      if (event.phase === 'native-usage') usageSeen();
    },
  }).finally(() => {
    settled = true;
  });
  await Promise.race([usage, pending.then(() => assert.fail('returned before owned child exit'))]);
  assert.equal(settled, false, 'valid JSON and usage do not release the owned CLI before exit');
  assert.equal(
    traces.some((trace) => trace.phase === 'native-completed'),
    false,
  );
  writeFileSync(release, 'exit');
  if (failed) {
    await assert.rejects(pending, /Qualification native result unavailable/);
    assert.equal(
      traces.some((trace) => trace.phase === 'native-completed'),
      false,
    );
  } else {
    const output = await pending;
    assert.equal(parseQualification(output, batch).size, 1);
    const completed = traces.find((trace) => trace.phase === 'native-completed');
    assert.equal(completed.outputChars, output.length);
    assert.ok(completed.afterUsageMs >= 0);
    const message = traces.find((trace) => trace.phase === 'native-output');
    assert.equal(message.usage.output_tokens_details.thinking_tokens, 1080);
    assert.equal(message.outputChars, output.length);
  }
  assert.equal(spawned, 1);
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE-|FULL-L0|private-source|private-message|document recovery/);
}

test(
  'actual native qualification carrier uses the guarded mode and waits for its owned child to exit',
  { timeout: 10000 },
  async (t) => exercise(t),
);
test(
  'actual native qualification keeps the failed-terminal fence even after valid JSON and usage',
  { timeout: 10000 },
  async (t) => exercise(t, true),
);
