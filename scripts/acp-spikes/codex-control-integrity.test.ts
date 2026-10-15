import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { controlKey } from './codex-control-journal.js';
import { CodexNativeFence, type NativeCodexBridge } from './codex-native-fence.js';

const input = {
  action: 'steer',
  sessionId: 'thread',
  nativeSessionId: 'thread',
  bindingRevision: 'binding',
  expectedTurnId: 'A',
  operationId: 'op',
  prompt: [{ type: 'text', text: 'sentinel' }],
};
const snapshot = () => ({ sessionId: 'thread', currentTurnId: 'B' });
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const base = resolve(tmpdir());
  const dir = await mkdtemp(join(base, 'acp-control-integrity-'));
  t.after(async () => {
    if (!dir.startsWith(base + '/') && !dir.startsWith(base + '\\')) throw new Error('unsafe_test_cleanup');
    await rm(dir, { recursive: true, force: true });
  });
  return { journalDirectory: dir, bindingRevision: 'binding' };
}
for (const field of ['nativeSessionId', 'nativeTurnId', 'clientUserMessageId', 'nativeItemId', 'prompt'] as const) {
  test(`W4.P native reconciliation rejects mismatched ${field} without a retry`, async (t) => {
    const options = await directory(t);
    let calls = 0;
    let accepted: Parameters<NativeCodexBridge['steerTurn']>[0] | undefined;
    const bridge: NativeCodexBridge = {
      async steerTurn(params) {
        calls++;
        accepted = params;
        throw new Error('lost_reply');
      },
      async readUserMessage() {
        assert.ok(accepted?.clientUserMessageId);
        return {
          nativeSessionId: 'thread',
          nativeTurnId: 'A',
          nativeItemId: 'item',
          clientUserMessageId: accepted.clientUserMessageId,
          prompt: accepted.prompt,
          [field]:
            field === 'prompt' ? [{ type: 'text', text: 'different' }] : field === 'nativeItemId' ? '' : 'foreign',
        };
      },
    };
    await assert.rejects(new CodexNativeFence(snapshot, bridge, options).handle(input), /lost_reply/);
    assert.equal((await new CodexNativeFence(snapshot, bridge, options).handle(input))['outcome'], 'outcome_unknown');
    assert.equal(calls, 1);
  });
}
test('W4.P pending persistence snapshots the caller payload before it can change', async (t) => {
  const options = await directory(t);
  const sent: unknown[] = [];
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn(params) {
        sent.push(params);
        return { turnId: 'A' };
      },
    },
    options,
  );
  const mutable = { ...input, prompt: [{ type: 'text', text: 'sentinel' }] };
  const pending = control.handle(mutable);
  mutable.prompt[0].text = 'mutated after admission';
  await pending;
  assert.deepEqual((sent[0] as { prompt: unknown }).prompt, input.prompt);
});
test('W4.P a corrupt durable record cannot authorize a native retry', async (t) => {
  const options = await directory(t);
  const key = controlKey('binding', 'thread', 'op');
  await mkdir(join(options.journalDirectory, key));
  await writeFile(join(options.journalDirectory, key, 'record.json'), '{corrupt');
  let calls = 0;
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn() {
        calls++;
        return { turnId: 'A' };
      },
    },
    options,
  );
  await assert.rejects(control.handle(input), /control_journal_unreadable/);
  assert.equal(calls, 0);
});
test('W4.P a crashed empty claim remains unknown and cannot be stolen', async (t) => {
  const options = await directory(t);
  await mkdir(join(options.journalDirectory, controlKey('binding', 'thread', 'op')));
  let calls = 0;
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn() {
        calls++;
        return { turnId: 'A' };
      },
    },
    options,
  );
  assert.equal((await control.handle(input))['outcome'], 'outcome_unknown');
  assert.equal(calls, 0);
});
test('W4.P a failed durable intent write prevents any native call', async (t) => {
  const options = await directory(t);
  const file = join(options.journalDirectory, 'not-a-directory');
  await writeFile(file, 'fixture');
  let calls = 0;
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn() {
        calls++;
        return { turnId: 'A' };
      },
    },
    { ...options, journalDirectory: file },
  );
  await assert.rejects(control.handle(input));
  assert.equal(calls, 0);
});
for (const corruption of ['missing-proof', 'foreign-turn', 'foreign-client'] as const) {
  test(`W4.P valid JSON with ${corruption} cannot claim confirmed injection`, async (t) => {
    const options = await directory(t);
    let calls = 0;
    const bridge = {
      async steerTurn() {
        calls++;
        return { turnId: 'A' };
      },
    };
    await new CodexNativeFence(snapshot, bridge, options).handle(input);
    const path = join(options.journalDirectory, controlKey('binding', 'thread', 'op'), 'record.json');
    const intent = JSON.parse(await readFile(path, 'utf8')) as { receipt: { nativeReceipt?: Record<string, unknown> } };
    if (corruption === 'missing-proof') delete intent.receipt.nativeReceipt;
    else
      intent.receipt.nativeReceipt =
        corruption === 'foreign-turn'
          ? { turnId: 'foreign' }
          : {
              turnId: 'A',
              source: 'native_history',
              nativeItemId: 'item',
              clientUserMessageId: 'foreign',
            };
    await writeFile(path, JSON.stringify(intent));
    await assert.rejects(new CodexNativeFence(snapshot, bridge, options).handle(input), /control_journal_corrupt/);
    assert.equal(calls, 1);
  });
}
test('W4.P mutating a returned receipt cannot alter a later replayed terminal', async (t) => {
  const options = await directory(t);
  let calls = 0;
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn() {
        calls++;
        return { turnId: 'A' };
      },
    },
    options,
  );
  const receipt = await control.handle(input);
  receipt['outcome'] = 'corrupt';
  (receipt['nativeReceipt'] as { turnId: string }).turnId = 'foreign';
  const replayed = await control.handle(input);
  assert.equal(replayed['outcome'], 'injected');
  assert.equal((replayed['nativeReceipt'] as { turnId: string }).turnId, 'A');
  assert.equal(calls, 1);
});
