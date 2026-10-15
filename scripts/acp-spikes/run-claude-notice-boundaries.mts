import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createClaudeBoundaryHarness } from './claude-boundary-harness.mjs';
import { checkNativeHash, nativeBinding } from './claude-native-binding.mjs';

if (process.env.CLOWDER_SPIKE_AUTHORIZED !== '1') throw new Error('Explicit bounded model-test authorization required');
const ingressFault = process.env.CLOWDER_SPIKE_SDK_VARIANT === 'ingress';
const variant = ingressFault
  ? 'claude-ingress-fault'
  : process.env.CLOWDER_SPIKE_SDK_VARIANT === 'upgrade'
    ? 'claude-sdk-0.3.285-aligned'
    : 'claude';
const bridge = resolve('.cat-cafe/tmp/acp-prototypes', variant);
const runId =
  process.env.CLOWDER_SPIKE_RUN_ID ??
  (ingressFault ? 'ingress-1' : process.env.CLOWDER_SPIKE_SDK_VARIANT === 'upgrade' ? 'sdk-upgrade-2' : 'boundaries-6');
if (!/^[a-z0-9_-]{1,48}$/.test(runId)) throw new Error('Invalid isolated evidence run ID');
const dir = resolve('.cat-cafe/tmp/authorized-claude-notice-20261014', runId);
// Claim before the first write: existing failed/in-progress evidence is preserved.
await mkdir(resolve('.cat-cafe/tmp/authorized-claude-notice-20261014'), { recursive: true });
await mkdir(dir);
await mkdir(join(dir, 'fixture'), { recursive: true });
await mkdir(join(dir, 'home'), { recursive: true });
await writeFile(join(dir, 'fixture/sentinel.txt'), 'ACP-CLAUDE-BOUNDARY-SENTINEL-20261014\n');
const trace = join(dir, 'tools.jsonl');
await writeFile(trace, '');
const nativePin = nativeBinding(process.env.CLOWDER_SPIKE_NATIVE_VERSION);
const nativePath = resolve(`.cat-cafe/tmp/pinned-cli/claude-${nativePin.version}/claude.exe`);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
await checkNativeHash(nativePath, nativePin);
const started = Date.now();
const sdkPackage = JSON.parse(
  await readFile(join(bridge, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
);
const outcome: Record<string, unknown> = {
  evidenceKind: 'real_native_SDK_ACP_with_synthetic_human_answer',
  bridgePin: 'd0aafb1ca26427285ffaeac8d8a4452fff28e9c3',
  sdkVersion: sdkPackage.version,
  nativeVersion: nativePin.version,
  nativeSha256: nativePin.sha256,
  bundleHash: await hash(join(bridge, 'dist/acp-agent.js')),
  fixtureHash: await hash('scripts/acp-spikes/readonly-fixture-mcp.mjs'),
  hooksDisabled: true,
  userInstructionsDisabled: true,
  budgetUsd: 2,
  maxSdkTurns: 8,
  production: false,
  productionElicitationHandler: false,
};
outcome.runnerSources = await Promise.all(
  ['run-claude-notice-boundaries.mts', 'claude-boundary-harness.mts', 'claude-native-binding.mts'].map(async (file) => {
    const source = `scripts/acp-spikes/${file}`;
    await writeFile(join(dir, file), await readFile(source));
    return { source, sha256: await hash(source) };
  }),
);
outcome.executionParameters = {
  variant: process.env.CLOWDER_SPIKE_SDK_VARIANT ?? 'baseline',
  nativeVersion: nativePin.version,
  runId,
  authorized: true,
};
const {
  client,
  events,
  wire,
  controls,
  elicitations,
  native,
  lifecycle,
  toolEvents,
  waitFor,
  request,
  notice,
  run,
  setSessionId,
  hasPendingAnswer,
  answerPending,
} = await createClaudeBoundaryHarness({ bridge, dir, trace, nativePath, ingressFault });
let sessionId: string;
const limit = setTimeout(() => void client.close(), 180000);
try {
  await client.initialize();
  const session = await request('session/new', {
    cwd: join(dir, 'fixture'),
    mcpServers: [
      {
        name: 'fixture',
        command: process.execPath,
        args: [resolve('scripts/acp-spikes/readonly-fixture-mcp.mjs')],
        env: [
          { name: 'FIXTURE_DIR', value: join(dir, 'fixture') },
          { name: 'FIXTURE_TRACE', value: trace },
        ],
      },
    ],
    _meta: {
      claudeCode: {
        emitRawSDKMessages: true,
        options: {
          tools: [],
          allowedTools: [],
          settingSources: [],
          settings: { disableAllHooks: true, claudeMdExcludes: ['**'] },
          maxBudgetUsd: 2,
          maxTurns: 8,
          model: 'claude-opus-5-5',
          systemPrompt:
            'Only the synthetic read_fixture tool and plain synthetic test replies are authorized. No other files, tools, shell or edits. Reply briefly.',
        },
      },
    },
  });
  sessionId = session.sessionId as string;
  setSessionId(sessionId);
  outcome.sessionId = sessionId;
  await request('session/set_mode', { sessionId, modeId: 'default' });
  if (ingressFault) {
    const cancellation = run('cancel');
    await waitFor(async () => (await toolEvents()).some((e) => e.scenario === 'cancel' && e.phase === 'started'));
    const queued = await notice('Only acknowledge SYNTHETIC-INGRESS-NOTICE after the current fixture. No tools.');
    await waitFor(() =>
      events.some((e) => e.type === 'ingress_fault' && e.phase === 'held' && e.uuid === queued.nativeInputUuid),
    );
    assert.equal(lifecycle(queued.nativeInputUuid).length, 0);
    const cancelledAt = Date.now();
    client.cancelSession(sessionId);
    await cancellation.done;
    await waitFor(() => events.some((e) => e.type === 'ingress_fault' && e.phase === 'exited'));
    const exited = events.find((e) => e.type === 'ingress_fault' && e.phase === 'exited')!;
    assert.ok(Number(exited.t) >= cancelledAt);
    await assert.rejects(
      request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'must stay retired' }] }),
      /session has ended/,
    );
    await new Promise((resolve) => setTimeout(resolve, 8500));
    assert.equal(
      lifecycle(queued.nativeInputUuid).some((e) => e.message.state === 'started'),
      false,
    );
    const tools = await toolEvents();
    assert.equal(
      tools.some((e) => e.scenario === 'cancel' && e.phase === 'completed'),
      false,
    );
    outcome.ingressCancellation = {
      receipt: queued,
      cancelledAt,
      processExit: exited,
      nativeLifecycle: lifecycle(queued.nativeInputUuid),
      faultEvents: events.filter((e) => e.type === 'ingress_fault'),
      tools,
      localStreamError: cancellation.state.error,
      cancelledPromptResponses: wire.filter(
        (w) =>
          w.t >= cancelledAt && (w.message.result as { stopReason?: string } | undefined)?.stopReason === 'cancelled',
      ),
      oldBindingRetired: true,
      noticeNeverStarted: true,
      productionClientReopened: false,
    };
  } else {
    const human = run('elicitation');
    await waitFor(hasPendingAnswer);
    const waitingAt = Date.now();
    const n1 = await notice(
      'After the pending synthetic human confirmation is answered and the fixture finishes, acknowledge NOTICE-ONE. Keep the human question pending. No tools.',
    );
    const n2 = await notice(
      'After the same safe boundary also acknowledge NOTICE-TWO, after NOTICE-ONE. No extra tools or files.',
    );
    assert.notEqual(n1.nativeInputUuid, n2.nativeInputUuid);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(human.state.settledAt, 0);
    assert.equal(
      (await toolEvents()).some((e) => e.phase === 'elicitation_answered'),
      false,
    );
    assert.equal(
      lifecycle(n1.nativeInputUuid).some((e) => e.message.state === 'started'),
      false,
    );
    assert.equal(
      lifecycle(n2.nativeInputUuid).some((e) => e.message.state === 'started'),
      false,
    );
    outcome.pendingElicitation = {
      waitingAt,
      checkedAt: Date.now(),
      noticesQueued: [n1, n2],
      answered: false,
      primarySettled: false,
    };
    answerPending();
    await human.done;
    assert.equal(human.state.error, undefined);
    const starts = native().filter(
      (e) =>
        e.message.type === 'command_lifecycle' &&
        e.message.state === 'started' &&
        [n1.nativeInputUuid, n2.nativeInputUuid].includes(e.message.command_uuid),
    );
    assert.deepEqual(
      starts.map((e) => e.message.command_uuid),
      [n1.nativeInputUuid, n2.nativeInputUuid],
    );
    assert.ok(
      [n1, n2].every((n) =>
        native().some(
          (e) =>
            e.message.type === 'result' &&
            Array.isArray(e.message.user_message_uuids) &&
            e.message.user_message_uuids.includes(n.nativeInputUuid),
        ),
      ),
    );
    outcome.multipleNotices = { receipts: [n1, n2], starts, ordered: true, primarySettledAt: human.state.settledAt };
    const cancellation = run('cancel');
    await waitFor(async () => (await toolEvents()).some((e) => e.scenario === 'cancel' && e.phase === 'started'));
    const queued = await notice(
      'After the current fixture completes acknowledge QUEUED-CANCEL-NOTICE. Do not start a new prompt or use tools.',
    );
    await waitFor(() => lifecycle(queued.nativeInputUuid).some((e) => e.message.state === 'queued'));
    assert.equal(
      lifecycle(queued.nativeInputUuid).some((e) => e.message.state === 'started'),
      false,
    );
    const cancelledAt = Date.now();
    client.cancelSession(sessionId);
    await cancellation.done;
    await waitFor(() =>
      lifecycle(queued.nativeInputUuid).some((e) => ['cancelled', 'discarded'].includes(String(e.message.state))),
    );
    await waitFor(() =>
      wire.some(
        (w) =>
          w.t >= cancelledAt && (w.message.result as { stopReason?: string } | undefined)?.stopReason === 'cancelled',
      ),
    );
    // Isolated raw bridge continuation verifies the native queue. Production's quarantined client does not reopen.
    const continued = await request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Only reply RESUME-AFTER-CANCEL briefly. Do not use any tools or follow a cancelled queued notice.',
          },
        ],
      },
      90000,
    );
    assert.equal(continued.stopReason, 'end_turn');
    assert.equal(
      lifecycle(queued.nativeInputUuid).some((e) => e.message.state === 'started'),
      false,
    );
    outcome.queuedCancellation = {
      receipt: queued,
      cancelledAt,
      nativeLifecycle: lifecycle(queued.nativeInputUuid),
      localStreamError: cancellation.state.error,
      nativeWireCancelled: true,
      subsequentNativePrompt: continued,
      noticeNeverStarted: true,
      productionClientReopened: false,
    };
  }
  Object.assign(outcome, { success: true, durationMs: Date.now() - started });
} catch (error) {
  outcome.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  clearTimeout(limit);
  await writeFile(join(dir, 'events.json'), JSON.stringify(events));
  await writeFile(join(dir, 'wire.json'), JSON.stringify(wire));
  await writeFile(join(dir, 'controls.json'), JSON.stringify(controls));
  await writeFile(join(dir, 'elicitations.json'), JSON.stringify(elicitations));
  await writeFile(join(dir, 'result.json'), JSON.stringify(outcome, null, 2));
  await client.close();
}
console.log(JSON.stringify(outcome));
