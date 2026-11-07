import assert from 'node:assert/strict';
import '../helpers/setup-cat-registry.js';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { sanitizeRawEvent } from '../../dist/domains/cats/services/agents/providers/codex-audit-hooks.js';
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

async function exercise(t, failed = false, scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qualification-native-'));
  const release = join(root, 'exit');
  const controller = new AbortController();
  copyFileSync(process.env.CAT_TEMPLATE_PATH, join(root, 'cat-template.json'));
  const keys = [
    'HOME',
    'USERPROFILE',
    'CLAUDE_CONFIG_DIR',
    'CAT_CAFE_DATA_DIR',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_TEMPLATE_PATH',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => {
    process.env[key] = root;
  });
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  mkdirSync(join(root, '.cat-cafe', 'prompt-overlays'), { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  t.after(() =>
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }),
  );
  t.after(() => {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  });
  const originalGet = catRegistry.tryGet.bind(catRegistry);
  writeFileSync(
    join(root, '.cat-cafe', 'prompt-overlays', 'workflow-triggers.local.yaml'),
    JSON.stringify({ [originalGet('opus').config.breedId]: 'QUALIFICATION_HOST_WORKFLOW_CANARY' }),
  );
  t.mock.method(catRegistry, 'tryGet', (id) =>
    id === 'haiku55'
      ? {
          config: {
            ...originalGet('opus').config,
            id,
            name: 'Qualification member',
            displayName: 'Qualification member',
            nickname: undefined,
            relationshipKey: 'qualification',
            roleDescription: '只读资格判断',
            clientId: 'anthropic',
            defaultModel: model,
            accountRef: 'claude',
          },
        }
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
  t.mock.method(ClaudeAgentService.prototype, 'compileL0ToTempFile', async (userId, frozenInput) => {
    assert.equal(userId, 'owner');
    assert.equal(frozenInput.catId, 'haiku55');
    assert.equal(Object.isFrozen(frozenInput), true);
    assert.match(JSON.stringify(frozenInput.variables), /QUALIFICATION_HOST_WORKFLOW_CANARY/);
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
    assert.equal(options.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    assert.equal(readFileSync(at('--system-prompt-file'), 'utf8'), fullL0);
    // Only this owned fixture is spawned. The actual carrier, final launch
    // adapter, OAuth resolver and process-supervisor/exit path run unchanged.
    const script = `const fs=require('node:fs'); let input='';
      process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{
        const b=JSON.parse(input), emit=x=>console.log(JSON.stringify(x));
        const text=JSON.stringify({requestId:b.requestId,rows:b.rows.map(r=>${scenario.credentialQuote === true}?[r.id,'supported',r.body]:[r.id,'rejected',null])});
        emit({type:'system',subtype:'init',model:${JSON.stringify(model)},tools:[],mcp_servers:[]});
        emit({type:'stream_event',event:{type:'message_start',message:{model:${JSON.stringify(model)}}}});
        emit({type:'assistant',message:{model:${JSON.stringify(model)},content:[{type:'text',text}],
          usage:{output_tokens:1200,output_tokens_details:{thinking_tokens:1080,thinking:'PRIVATE-THINKING'}}}});
        if (!${scenario.missingResult === true}) emit({type:'result',subtype:${JSON.stringify(failed ? 'error_during_execution' : 'success')},
          is_error:${failed},result:${scenario.resultMismatch ? "'{}'" : 'text'},usage:{output_tokens:1200},duration_ms:10,total_cost_usd:0});
        if (${scenario.lateFailure === true}) emit({type:'result',subtype:'error_during_execution',is_error:true,result:text});
        const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(wait);process.exit(${scenario.exitCode ?? 0})}},10);
      });`;
    const child = actualSpawn(process.execPath, ['-e', script], options);
    if (scenario.cancelOnExit)
      child.once('exit', () => controller.abort(new DOMException('Qualification deadline', 'TimeoutError')));
    return child;
  });
  const body = scenario.credentialQuote ? `a public synthetic fixture ghp_${'a'.repeat(36)}` : 'a different subject';
  const batch = qualificationBatch('document recovery', [
    {
      threadId: 'private-source',
      messageId: 'private-message',
      content: body,
      contentRevision: contentRevision(body),
    },
  ]);
  if (scenario.credentialQuote) {
    const wire = JSON.stringify({ requestId: batch.requestId, rows: [['c0', 'supported', body]] });
    assert.notEqual(
      sanitizeRawEvent({ type: 'result', result: wire }).result,
      wire,
      'the actual archive sanitizer changes this fixture',
    );
  }
  const traces = [];
  let usageSeen;
  const usage = new Promise((resolve) => {
    usageSeen = resolve;
  });
  let settled = false;
  let teardownRegistered = false;
  let ownedClosed = false;
  const pending = runNativeQueryBatch(batch, {
    userId: 'owner',
    signal: controller.signal,
    deadlineAt: Date.now() + 15000,
    ...(scenario.cancelOnExit || scenario.cancelOnOutput ? { deadlineSignal: controller.signal } : {}),
    ...(scenario.external ? { requestSignal: controller.signal } : {}),
    onTeardown: (closed) => {
      teardownRegistered = true;
      void closed.then(() => {
        ownedClosed = true;
      });
    },
    onResult: (text) => {
      if (scenario.rejectSeal) return false;
      try {
        parseQualification(text, batch);
        if (scenario.cancelAfterSeal)
          setImmediate(() => controller.abort(new DOMException('Qualification deadline', 'TimeoutError')));
        return true;
      } catch {
        return false;
      }
    },
    onTrace: (event) => {
      traces.push(privateMessageSearchTrace(event));
      if (scenario.throwOnCloseTrace && event.phase === 'native-closed') throw new Error('telemetry sink failed');
      if (scenario.cancelOnOutput && event.phase === 'native-output' && event.outputChars > 0)
        controller.abort(new DOMException('Qualification deadline', 'TimeoutError'));
      if (
        event.phase === 'native-usage' ||
        (scenario.missingResult && event.phase === 'native-output' && event.outputChars > 0)
      )
        usageSeen();
    },
  }).finally(() => {
    settled = true;
  });
  await Promise.race([usage, pending.then(() => assert.fail('returned before owned child exit'))]);
  assert.equal(settled, false, 'valid JSON and usage do not release the owned CLI before exit');
  assert.equal(teardownRegistered, true, 'the native process supplies the qualifier its actual close promise');
  if (!scenario.cancelOnOutput) assert.equal(ownedClosed, false);
  assert.equal(
    traces.some((trace) => trace.phase === 'native-completed'),
    false,
  );
  if (!scenario.cancelAfterSeal) writeFileSync(release, 'exit');
  if (failed || scenario.reject) {
    await assert.rejects(pending, failed ? /Qualification native result unavailable/ : undefined);
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
    const auditText = sanitizeRawEvent({ message: { content: [{ type: 'text', text: output }] } }).message.content[0]
      .text;
    assert.equal(message.outputChars, auditText.length);
  }
  if (scenario.boundaryTrace || scenario.cancelAfterSeal) {
    assert.equal(traces.find((event) => event.phase === 'native-seal')?.resultSealed, true);
    const rootExit = traces.find((event) => event.phase === 'native-root-exit');
    assert.ok(rootExit, 'the actual supervisor reports its provider root separately from its own close');
    if (scenario.cancelAfterSeal) assert.ok(rootExit.rootExitCode !== 0 || rootExit.rootExitSignal !== 'none');
    else {
      assert.equal(rootExit.rootExitCode, 0);
      assert.equal(rootExit.rootExitSignal, 'none');
    }
  }
  assert.equal(spawned, 1);
  assert.equal(ownedClosed, true, 'the same close promise resolves for successful and failed terminals');
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE-|FULL-L0|private-source|private-message|document recovery|ghp_/);
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

// Fire on the real supervisor exit, before its iterator has finished draining.
for (const [name, scenario] of [
  ['result admission and provider root exit are separate bounded private facts', { boundaryTrace: true }],
  ['a sealed result never turns a cutoff-killed provider into a success', { cancelAfterSeal: true, reject: true }],
  ['a completed, normally exited batch survives a late local work deadline', { cancelOnExit: true }],
  ['qualification uses the provider result rather than its sanitized audit copy', { credentialQuote: true }],
  ['a telemetry failure cannot interrupt owned close', { throwOnCloseTrace: true }],
  ['the failed-terminal fence survives a throwing close observer', { throwOnCloseTrace: true, failed: true }],
  [
    'the same late request cancellation still rejects a completed batch',
    { cancelOnExit: true, external: true, reject: true },
  ],
  ['valid text without a successful provider result never approves a batch', { missingResult: true, reject: true }],
  ['a Host-rejected result cannot complete before its delayed timer callback', { rejectSeal: true, reject: true }],
  ['a result drained after work cancellation is never sealed', { cancelOnOutput: true, reject: true }],
  ['a nonzero owned exit cannot be hidden by the late deadline', { cancelOnExit: true, exitCode: 2, reject: true }],
  [
    'a failed terminal after success still rejects the sealed output',
    { cancelOnExit: true, lateFailure: true, reject: true },
  ],
  [
    'a mismatching result cannot seal earlier valid text across expiry',
    { cancelOnExit: true, resultMismatch: true, reject: true },
  ],
])
  test(name, { timeout: 10000 }, async (t) => exercise(t, scenario.failed ?? false, scenario));
