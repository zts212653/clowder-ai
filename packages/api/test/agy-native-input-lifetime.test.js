import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { AgyNativeRunInput } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-run-input.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

test('Native rejects an upload root that was not granted to the running CLI', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-ungranted-upload-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const uploadDir = join(root, 'uploads');
  mkdirSync(workspace);
  mkdirSync(uploadDir);
  const image = join(uploadDir, 'shot.png');
  writeFileSync(image, 'attachment');
  let dispatch;
  let writes = 0;
  const run = new AgyNativeRunInput(
    {
      workingDirectory: workspace,
      uploadDir,
      activeRunDispatch: {
        invocationId: 'ungranted-upload',
        register(registration) {
          dispatch = registration.dispatch;
          return () => {};
        },
      },
    },
    () => {},
    workspace,
  );
  t.after(() => run.dispose());
  run.onStdinReady(() => {
    writes++;
  });
  run.register('ungranted-upload-session');
  const result = await dispatch(
    { text: 'Inspect', messageIds: ['image'], imagePaths: [image] },
    { expectedInvocationId: 'ungranted-upload' },
  );
  assert.equal(result.accepted, false);
  assert.equal(result.acceptance, 'not_accepted');
  assert.equal(writes, 0);
});

for (const boundary of ['result', 'stop', 'abort', 'result-without-attachment']) {
  test(`Native rejects unwritten supplements when ${boundary} closes the run during attachment resolution`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-attachment-race-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const image = join(root, 'shot.png');
    writeFileSync(image, 'attachment lifetime fixture');
    const controller = new AbortController();
    let closeCount = 0;
    let releaseCount = 0;
    let writeCount = 0;
    let completedCount = 0;
    let observedCount = 0;
    let dispatch;
    let resolveAttachment;
    const attachment = new Promise((resolve) => {
      resolveAttachment = resolve;
    });
    let enteredResolution;
    const resolving = new Promise((resolve) => {
      enteredResolution = resolve;
    });
    const run = new AgyNativeRunInput(
      {
        workingDirectory: root,
        signal: controller.signal,
        resolveTrustedImagePath: () => {
          enteredResolution();
          return attachment;
        },
        activeRunDispatch: {
          invocationId: 'inv-race',
          register(registration) {
            dispatch = registration.dispatch;
            return () => {
              releaseCount += 1;
            };
          },
        },
      },
      () => {
        closeCount += 1;
      },
      root,
      () => {
        observedCount += 1;
      },
    );
    t.after(() => run.dispose());
    run.onStdinReady(() => {
      if (closeCount) throw new Error('stdin is closed');
      writeCount += 1;
    });
    run.register('session-race');
    const result = dispatch(
      {
        deliveryId: 'delivery-race',
        text: 'Inspect this supplement.',
        messageIds: ['message-race'],
        ...(boundary === 'result-without-attachment' ? {} : { imagePaths: ['hmr:shot'] }),
        onInputCompleted: async () => {
          completedCount += 1;
        },
      },
      { expectedInvocationId: 'inv-race' },
    );
    if (boundary !== 'result-without-attachment') await resolving;
    if (boundary === 'abort') controller.abort();
    else if (boundary === 'stop') run.stop();
    else run.resultBoundary();
    resolveAttachment(image);
    assert.deepEqual(await result, {
      accepted: false,
      reason: 'active_run_closed',
      acceptance: 'not_accepted',
    });
    assert.equal(writeCount, 0);
    assert.equal(releaseCount, 1);
    assert.equal(observedCount, 0);
    assert.equal(run.hasUnfinishedInput, false);
    await run.dispose();
    assert.equal(completedCount, 0, 'a rejected supplement never acquires a completion receipt');
  });
}

test('Native keeps stream-json stdin open until the provider terminal, then exits without waiting for timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-input-life-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = 'gemini-3.8-flash-high';
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: process.execPath,
    l0CompilerFn: async () => '# Identity\nNative fixture.',
    profile: {
      enabled: true,
      model,
      profileId: 'gemini38',
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  const script = `
  const readline=require('node:readline');
  const [agent,cwd,model]=process.argv.slice(1);
  const send=(event)=>process.stdout.write(JSON.stringify(event)+'\\n');
  let closed=false;
  process.stdin.on('end',()=>{closed=true;});
  const input=readline.createInterface({input:process.stdin});
  input.once('line',()=>{
   send({event:'init',conversation_id:'stdin-lifetime',init:{agent,cwd,model,permission_mode:'request-review',tools:[]}});
   setTimeout(()=>send({event:'result',result:{conversation_id:'stdin-lifetime',status:closed?'ERROR':'SUCCESS',response:'Reply complete.',...(closed?{error:'stdin closed while this turn was still running'}:{})}}),100);
  });
 `;
  try {
    const messages = [];
    for await (const message of service.invoke('Complete one turn.', {
      workingDirectory: workspace,
      spawnCliOverride: (launch) =>
        spawnCli({
          ...launch,
          command: process.execPath,
          args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
          timeoutMs: 3000,
        }),
    }))
      messages.push(message);
    assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages.filter((m) => m.type === 'error')));
    assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    assert.equal(messages.find((m) => m.type === 'text')?.content, 'Reply complete.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
